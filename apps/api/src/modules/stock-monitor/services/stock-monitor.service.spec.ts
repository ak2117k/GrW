import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StockMonitor } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { MarketDataGateway } from '../../market-data/gateways/market-data.gateway';
import {
  StockMonitorService,
  computePercent,
  computeTargetPrice,
  isHit,
} from './stock-monitor.service';

/** Build a persisted-monitor fixture with sensible defaults. */
function monitor(overrides: Partial<StockMonitor> = {}): StockMonitor {
  const now = new Date('2026-07-11T04:00:00.000Z');
  return {
    id: 'mon_1',
    userId: 'user_1',
    symbol: 'INFY',
    exchange: 'NSE',
    token: '1594',
    referencePrice: 100,
    targetPercent: 10,
    targetPrice: 110,
    status: 'WATCHING',
    lastLtp: 100,
    currentPercent: 0,
    triggeredAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as StockMonitor;
}

describe('stock-monitor pure helpers', () => {
  describe('computePercent', () => {
    it('computes the percent move off the reference', () => {
      expect(computePercent(100, 110)).toBe(10);
      expect(computePercent(200, 180)).toBe(-10);
    });

    it('guards a zero reference', () => {
      expect(computePercent(0, 50)).toBe(0);
    });
  });

  describe('computeTargetPrice', () => {
    it('applies the upside target percent', () => {
      expect(computeTargetPrice(100, 10)).toBe(110);
      expect(computeTargetPrice(250, 4)).toBe(260);
    });
  });

  describe('isHit', () => {
    it('is true at or above the target', () => {
      expect(isHit(110, 110)).toBe(true);
      expect(isHit(111, 110)).toBe(true);
    });

    it('is false below the target', () => {
      expect(isHit(109.9, 110)).toBe(false);
    });

    it('is false for a null (uncaptured) target', () => {
      expect(isHit(9999, null)).toBe(false);
    });
  });
});

describe('StockMonitorService', () => {
  let service: StockMonitorService;
  let prisma: {
    stockMonitor: {
      findMany: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    alert: { create: jest.Mock };
  };
  let feed: { subscribe: jest.Mock; getQuote: jest.Mock; isMarketOpen: jest.Mock };
  let gateway: { server: { emit: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      stockMonitor: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      alert: { create: jest.fn().mockResolvedValue({ id: 'alert_1' }) },
    };
    feed = {
      subscribe: jest.fn().mockResolvedValue([]),
      getQuote: jest.fn().mockReturnValue(null),
      isMarketOpen: jest.fn().mockReturnValue(true),
    };
    gateway = { server: { emit: jest.fn() } };

    const mod = await Test.createTestingModule({
      providers: [
        StockMonitorService,
        { provide: PrismaService, useValue: prisma },
        { provide: MarketFeedService, useValue: feed },
        { provide: MarketDataGateway, useValue: gateway },
      ],
    }).compile();

    service = mod.get(StockMonitorService);
  });

  describe('add', () => {
    const dto = { symbol: 'INFY', exchange: 'NSE', token: '1594', targetPercent: 10 };

    it('subscribes the token and captures reference + target price when priced', async () => {
      feed.getQuote.mockReturnValue({ ltp: 100 });
      prisma.stockMonitor.create.mockResolvedValue(
        monitor({ referencePrice: 100, targetPrice: 110, lastLtp: 100, currentPercent: 0 }),
      );

      const result = await service.add('user_1', dto);

      expect(feed.subscribe).toHaveBeenCalledWith(['1594']);
      const data = prisma.stockMonitor.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        userId: 'user_1',
        symbol: 'INFY',
        exchange: 'NSE',
        token: '1594',
        targetPercent: 10,
        referencePrice: 100,
        targetPrice: 110,
        status: 'WATCHING',
        lastLtp: 100,
        currentPercent: 0,
      });
      expect(result.referencePrice).toBe(100);
      expect(result.targetPrice).toBe(110);
    });

    it('defers the reference (null) when the instrument is unpriced', async () => {
      feed.getQuote.mockReturnValue(null);
      prisma.stockMonitor.create.mockResolvedValue(
        monitor({ referencePrice: null, targetPrice: null, lastLtp: null, currentPercent: null }),
      );

      await service.add('user_1', dto);

      const data = prisma.stockMonitor.create.mock.calls[0][0].data;
      expect(data.referencePrice).toBeNull();
      expect(data.targetPrice).toBeNull();
      expect(data.currentPercent).toBeNull();
    });

    it('ignores a zero/degenerate quote and defers the reference', async () => {
      feed.getQuote.mockReturnValue({ ltp: 0 });
      prisma.stockMonitor.create.mockResolvedValue(monitor({ referencePrice: null }));

      await service.add('user_1', dto);

      expect(prisma.stockMonitor.create.mock.calls[0][0].data.referencePrice).toBeNull();
    });

    it('still creates the row when the feed subscribe throws', async () => {
      feed.subscribe.mockRejectedValue(new Error('feed down'));
      feed.getQuote.mockReturnValue({ ltp: 100 });
      prisma.stockMonitor.create.mockResolvedValue(monitor());

      await expect(service.add('user_1', dto)).resolves.toBeDefined();
      expect(prisma.stockMonitor.create).toHaveBeenCalled();
    });

    it('maps a unique-constraint violation to a 409', async () => {
      feed.getQuote.mockReturnValue({ ltp: 100 });
      prisma.stockMonitor.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.add('user_1', dto)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('list → DTO mapping', () => {
    it('returns the caller rows newest-first with ISO dates and explicit nulls', async () => {
      const createdAt = new Date('2026-07-11T04:00:00.000Z');
      prisma.stockMonitor.findMany.mockResolvedValue([
        monitor({
          id: 'w1',
          status: 'WATCHING',
          referencePrice: 100,
          targetPrice: 110,
          lastLtp: 105,
          currentPercent: 5,
          triggeredAt: null,
          createdAt,
        }),
      ]);

      const dtos = await service.list('user_1');

      expect(prisma.stockMonitor.findMany).toHaveBeenCalledWith({
        where: { userId: 'user_1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(dtos[0]).toEqual({
        id: 'w1',
        symbol: 'INFY',
        exchange: 'NSE',
        token: '1594',
        referencePrice: 100,
        targetPercent: 10,
        targetPrice: 110,
        status: 'WATCHING',
        lastLtp: 105,
        currentPercent: 5,
        triggeredAt: null,
        createdAt: '2026-07-11T04:00:00.000Z',
      });
    });

    it('emits an ISO triggeredAt for a TARGET_HIT row', async () => {
      const triggeredAt = new Date('2026-07-11T06:30:00.000Z');
      prisma.stockMonitor.findMany.mockResolvedValue([
        monitor({ status: 'TARGET_HIT', triggeredAt }),
      ]);
      const [dto] = await service.list('user_1');
      expect(dto.status).toBe('TARGET_HIT');
      expect(dto.triggeredAt).toBe('2026-07-11T06:30:00.000Z');
    });
  });

  describe('remove', () => {
    it('deletes scoped by [id, userId]', async () => {
      await service.remove('user_1', 'mon_1');
      expect(prisma.stockMonitor.deleteMany).toHaveBeenCalledWith({
        where: { id: 'mon_1', userId: 'user_1' },
      });
    });
  });

  describe('distinctWatchingTokens', () => {
    it('reads distinct tokens across all WATCHING monitors', async () => {
      prisma.stockMonitor.findMany.mockResolvedValue([{ token: '111' }, { token: '222' }]);
      const tokens = await service.distinctWatchingTokens();
      expect(prisma.stockMonitor.findMany).toHaveBeenCalledWith({
        where: { status: 'WATCHING' },
        select: { token: true },
        distinct: ['token'],
      });
      expect(tokens).toEqual(['111', '222']);
    });
  });

  describe('sweep', () => {
    it('captures the reference on the first priced tick and skips the hit test', async () => {
      prisma.stockMonitor.findMany.mockResolvedValue([
        monitor({ referencePrice: null, targetPrice: null, targetPercent: 10 }),
      ]);
      feed.getQuote.mockReturnValue({ ltp: 200 });

      await service.sweep();

      const call = prisma.stockMonitor.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'mon_1', userId: 'user_1' });
      expect(call.data).toEqual({
        referencePrice: 200,
        targetPrice: 220, // 200 * 1.10
        lastLtp: 200,
        currentPercent: 0,
      });
      expect(prisma.alert.create).not.toHaveBeenCalled();
    });

    it('updates lastLtp + currentPercent when below target (no fire)', async () => {
      prisma.stockMonitor.findMany.mockResolvedValue([
        monitor({ referencePrice: 100, targetPrice: 110 }),
      ]);
      feed.getQuote.mockReturnValue({ ltp: 105 });

      await service.sweep();

      const call = prisma.stockMonitor.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'mon_1', userId: 'user_1' });
      expect(call.data).toEqual({ lastLtp: 105, currentPercent: 5 });
      expect(prisma.alert.create).not.toHaveBeenCalled();
      expect(gateway.server.emit).not.toHaveBeenCalled();
    });

    it('flips to TARGET_HIT and fires exactly once on a hit', async () => {
      prisma.stockMonitor.findMany.mockResolvedValue([
        monitor({ referencePrice: 100, targetPrice: 110 }),
      ]);
      feed.getQuote.mockReturnValue({ ltp: 112 });
      prisma.stockMonitor.updateMany.mockResolvedValue({ count: 1 });

      await service.sweep();

      const call = prisma.stockMonitor.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'mon_1', userId: 'user_1', status: 'WATCHING' });
      expect(call.data).toMatchObject({ status: 'TARGET_HIT', lastLtp: 112 });
      expect(call.data.triggeredAt).toBeInstanceOf(Date);

      // Alert persisted scoped to the owner, inactive + triggered.
      expect(prisma.alert.create).toHaveBeenCalledTimes(1);
      const alertData = prisma.alert.create.mock.calls[0][0].data;
      expect(alertData).toMatchObject({
        userId: 'user_1',
        type: 'price',
        condition: 'above',
        value: 110,
        isActive: false,
      });
      expect(alertData.triggeredAt).toBeInstanceOf(Date);

      // WS toast emitted best-effort.
      expect(gateway.server.emit).toHaveBeenCalledTimes(1);
      expect(gateway.server.emit.mock.calls[0][0]).toBe('alert');
    });

    it('does NOT fire when the status guard loses the race (count 0)', async () => {
      prisma.stockMonitor.findMany.mockResolvedValue([
        monitor({ referencePrice: 100, targetPrice: 110 }),
      ]);
      feed.getQuote.mockReturnValue({ ltp: 112 });
      prisma.stockMonitor.updateMany.mockResolvedValue({ count: 0 });

      await service.sweep();

      expect(prisma.alert.create).not.toHaveBeenCalled();
      expect(gateway.server.emit).not.toHaveBeenCalled();
    });

    it('is idempotent — a re-sweep after the hit reads no WATCHING rows and does not re-fire', async () => {
      // First sweep: row is WATCHING, price hits, fires once.
      prisma.stockMonitor.findMany.mockResolvedValueOnce([
        monitor({ referencePrice: 100, targetPrice: 110 }),
      ]);
      feed.getQuote.mockReturnValue({ ltp: 112 });
      prisma.stockMonitor.updateMany.mockResolvedValue({ count: 1 });
      await service.sweep();
      expect(prisma.alert.create).toHaveBeenCalledTimes(1);

      // Second sweep: the row is now TARGET_HIT so the WATCHING query returns [].
      prisma.stockMonitor.findMany.mockResolvedValueOnce([]);
      await service.sweep();
      expect(prisma.alert.create).toHaveBeenCalledTimes(1); // unchanged
    });

    it('skips monitors with no cached / non-positive quote', async () => {
      prisma.stockMonitor.findMany.mockResolvedValue([
        monitor({ id: 'a', token: '111' }),
        monitor({ id: 'b', token: '222' }),
      ]);
      feed.getQuote.mockImplementation((token: string) =>
        token === '111' ? null : { ltp: 0 },
      );

      await service.sweep();

      expect(prisma.stockMonitor.updateMany).not.toHaveBeenCalled();
    });

    it('does not undo the DB write when the WS emit throws', async () => {
      prisma.stockMonitor.findMany.mockResolvedValue([
        monitor({ referencePrice: 100, targetPrice: 110 }),
      ]);
      feed.getQuote.mockReturnValue({ ltp: 112 });
      prisma.stockMonitor.updateMany.mockResolvedValue({ count: 1 });
      gateway.server.emit.mockImplementation(() => {
        throw new Error('socket gone');
      });

      await expect(service.sweep()).resolves.toBeUndefined();
      expect(prisma.alert.create).toHaveBeenCalledTimes(1);
    });
  });
});
