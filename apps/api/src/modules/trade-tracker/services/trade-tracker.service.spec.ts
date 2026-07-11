import { Test } from '@nestjs/testing';
import type { TradeTracker } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CREDENTIAL_DECRYPTOR } from '../../credential-vault/execution/credential-decryptor';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';
import {
  TradeTrackerService,
  computePnl,
  computeTickPatch,
  istDateString,
  normalizeHoldings,
  normalizePositions,
} from './trade-tracker.service';

/** Build a persisted-tracker fixture with sensible defaults. */
function tracker(overrides: Partial<TradeTracker> = {}): TradeTracker {
  const now = new Date('2026-07-11T04:00:00.000Z');
  return {
    id: 'trk_1',
    userId: 'user_1',
    symbol: 'INFY',
    exchange: 'NSE',
    token: '1594',
    kind: 'HOLDING',
    entryPrice: 100,
    qty: 10,
    entryTime: now,
    exitPrice: null,
    exitTime: null,
    status: 'OPEN',
    holdingHigh: 100,
    holdingLow: 100,
    dayHigh: 100,
    dayLow: 100,
    dayDate: istDateString(now),
    lastLtp: 100,
    pnl: 0,
    pnlPercent: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TradeTracker;
}

describe('trade-tracker pure helpers', () => {
  describe('computePnl', () => {
    it('computes rupee + percent P&L off entry', () => {
      expect(computePnl(100, 110, 10)).toEqual({ pnl: 100, pnlPercent: 10 });
    });

    it('is negative below entry', () => {
      expect(computePnl(200, 180, 5)).toEqual({ pnl: -100, pnlPercent: -10 });
    });

    it('guards divide-by-zero entry', () => {
      expect(computePnl(0, 50, 1)).toEqual({ pnl: 50, pnlPercent: 0 });
    });
  });

  describe('computeTickPatch', () => {
    const now = new Date('2026-07-11T05:30:00.000Z');
    const today = istDateString(now);

    it('raises the holding + day high on a new peak', () => {
      const patch = computeTickPatch(
        tracker({ holdingHigh: 100, holdingLow: 90, dayHigh: 100, dayLow: 90, dayDate: today }),
        110,
        now,
      );
      expect(patch.holdingHigh).toBe(110);
      expect(patch.dayHigh).toBe(110);
      expect(patch.holdingLow).toBe(90); // unchanged
      expect(patch.dayLow).toBe(90);
      expect(patch.lastLtp).toBe(110);
    });

    it('lowers the holding + day low on a new trough', () => {
      const patch = computeTickPatch(
        tracker({ holdingHigh: 100, holdingLow: 90, dayHigh: 100, dayLow: 90, dayDate: today }),
        80,
        now,
      );
      expect(patch.holdingLow).toBe(80);
      expect(patch.dayLow).toBe(80);
      expect(patch.holdingHigh).toBe(100); // unchanged
    });

    it('resets ONLY the day extremes (not holding) when the IST date rolls', () => {
      const patch = computeTickPatch(
        tracker({
          holdingHigh: 150,
          holdingLow: 50,
          dayHigh: 140,
          dayLow: 120,
          dayDate: '2000-01-01', // stale day marker
        }),
        130,
        now,
      );
      // Day extremes reset to the fresh ltp and stamp today's date...
      expect(patch.dayHigh).toBe(130);
      expect(patch.dayLow).toBe(130);
      expect(patch.dayDate).toBe(today);
      // ...but the holding-period extreme keeps accumulating across days.
      expect(patch.holdingHigh).toBe(150);
      expect(patch.holdingLow).toBe(50);
    });

    it('recomputes P&L from the tick', () => {
      const patch = computeTickPatch(
        tracker({ entryPrice: 100, qty: 10, dayDate: today }),
        120,
        now,
      );
      expect(patch.pnl).toBe(200);
      expect(patch.pnlPercent).toBe(20);
    });
  });

  describe('normalizePositions', () => {
    it('maps open positions and drops squared-off (netqty 0) legs', () => {
      const items = normalizePositions([
        { symboltoken: '111', tradingsymbol: 'NIFTY', exchange: 'NFO', netqty: '50', avgnetprice: '100.5', ltp: '105' },
        { symboltoken: '222', tradingsymbol: 'BANKNIFTY', exchange: 'NFO', netqty: '0', avgnetprice: '200', ltp: '210' },
      ]);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'POSITION',
        token: '111',
        symbol: 'NIFTY',
        exchange: 'NFO',
        entryPrice: 100.5,
        qty: 50,
        ltp: 105,
      });
    });

    it('returns [] for a non-array', () => {
      expect(normalizePositions(null)).toEqual([]);
    });
  });

  describe('normalizeHoldings', () => {
    it('maps holdings and drops zero-quantity rows', () => {
      const items = normalizeHoldings([
        { symboltoken: '1594', tradingsymbol: 'INFY', exchange: 'NSE', quantity: '10', averageprice: '1400', ltp: '1500' },
        { symboltoken: '99', tradingsymbol: 'ZERO', exchange: 'NSE', quantity: '0', averageprice: '10', ltp: '11' },
      ]);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'HOLDING',
        token: '1594',
        entryPrice: 1400,
        qty: 10,
        ltp: 1500,
      });
    });
  });
});

describe('TradeTrackerService', () => {
  let service: TradeTrackerService;
  let prisma: {
    tradeTracker: {
      findMany: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
    brokerCredential: { findMany: jest.Mock };
  };
  let decryptor: { withDecryptedCredentials: jest.Mock };
  let brokerFactory: { withSession: jest.Mock };

  beforeEach(async () => {
    prisma = {
      tradeTracker: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      brokerCredential: { findMany: jest.fn().mockResolvedValue([]) },
    };
    decryptor = { withDecryptedCredentials: jest.fn() };
    brokerFactory = { withSession: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        TradeTrackerService,
        { provide: PrismaService, useValue: prisma },
        { provide: CREDENTIAL_DECRYPTOR, useValue: decryptor },
        { provide: PerUserBrokerSessionFactory, useValue: brokerFactory },
      ],
    }).compile();

    service = mod.get(TradeTrackerService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('reconcile', () => {
    const positions = [
      { symboltoken: '111', tradingsymbol: 'NIFTY', exchange: 'NFO', netqty: '50', avgnetprice: '100', ltp: '120' },
    ];
    const holdings = [
      { symboltoken: '1594', tradingsymbol: 'INFY', exchange: 'NSE', quantity: '10', averageprice: '1000', ltp: '1100' },
    ];

    it('opens a tracker for each first-seen instrument, seeding extremes from ltp', async () => {
      prisma.tradeTracker.findMany.mockResolvedValue([]); // nothing tracked yet

      await service.reconcile('user_1', positions, holdings);

      expect(prisma.tradeTracker.create).toHaveBeenCalledTimes(2);
      const posData = prisma.tradeTracker.create.mock.calls[0][0].data;
      expect(posData).toMatchObject({
        userId: 'user_1',
        kind: 'POSITION',
        token: '111',
        entryPrice: 100,
        qty: 50,
        status: 'OPEN',
        // extremes + lastLtp all seeded from the current ltp (120)
        holdingHigh: 120,
        holdingLow: 120,
        dayHigh: 120,
        dayLow: 120,
        lastLtp: 120,
      });
      expect(posData.dayDate).toBe(istDateString(new Date()));
      // pnl seeded off entry→ltp: (120-100)*50 = 1000
      expect(posData.pnl).toBe(1000);
      expect(prisma.tradeTracker.updateMany).not.toHaveBeenCalled();
    });

    it('closes an OPEN tracker whose instrument left the book', async () => {
      // A holding tracked last cycle that is no longer in the (empty) book.
      prisma.tradeTracker.findMany.mockResolvedValue([
        tracker({ id: 'gone_1', token: '1594', kind: 'HOLDING', entryPrice: 1000, qty: 10, lastLtp: 1200 }),
      ]);

      await service.reconcile('user_1', [], []);

      expect(prisma.tradeTracker.create).not.toHaveBeenCalled();
      expect(prisma.tradeTracker.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.tradeTracker.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'gone_1', userId: 'user_1' });
      expect(call.data).toMatchObject({
        status: 'CLOSED',
        exitPrice: 1200, // last known ltp
        pnl: 2000, // (1200-1000)*10
      });
      expect(call.data.exitTime).toBeInstanceOf(Date);
    });

    it('is idempotent — a re-run with the same book neither opens nor closes', async () => {
      // Book already fully tracked as OPEN.
      prisma.tradeTracker.findMany.mockResolvedValue([
        tracker({ id: 'p', token: '111', kind: 'POSITION' }),
        tracker({ id: 'h', token: '1594', kind: 'HOLDING' }),
      ]);

      await service.reconcile('user_1', positions, holdings);

      expect(prisma.tradeTracker.create).not.toHaveBeenCalled();
      expect(prisma.tradeTracker.updateMany).not.toHaveBeenCalled();
    });

    it('scopes the OPEN lookup by userId', async () => {
      await service.reconcile('user_9', [], []);
      expect(prisma.tradeTracker.findMany).toHaveBeenCalledWith({
        where: { userId: 'user_9', status: 'OPEN' },
      });
    });
  });

  describe('backfill', () => {
    it('snapshots the caller book via the ephemeral session and reconciles it', async () => {
      // Wire the isolated decrypt lease → disposable broker session, returning
      // one open position + one holding.
      const session = {
        getPositions: jest
          .fn()
          .mockResolvedValue([
            { symboltoken: '111', tradingsymbol: 'NIFTY', exchange: 'NFO', netqty: '25', avgnetprice: '100', ltp: '130' },
          ]),
        getHoldings: jest.fn().mockResolvedValue({
          holdings: [
            { symboltoken: '1594', tradingsymbol: 'INFY', exchange: 'NSE', quantity: '10', averageprice: '1000', ltp: '1050' },
          ],
        }),
      };
      brokerFactory.withSession.mockImplementation((_creds: unknown, fn: any) => fn(session));
      decryptor.withDecryptedCredentials.mockImplementation(
        (_userId: string, _ctx: unknown, use: any) => use({ apiKey: 'k' }),
      );
      prisma.tradeTracker.findMany.mockResolvedValue([]);

      await service.backfill('user_1');

      expect(decryptor.withDecryptedCredentials).toHaveBeenCalledWith(
        'user_1',
        { reason: 'REVALIDATE' },
        expect.any(Function),
      );
      expect(prisma.tradeTracker.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('applyTick / flushTicks', () => {
    beforeEach(() => jest.useFakeTimers());

    it('debounces: many calls within the window schedule ONE flush', async () => {
      const flushSpy = jest.spyOn(service, 'flushTicks').mockResolvedValue(undefined);

      service.applyTick('111', 100);
      service.applyTick('111', 101);
      service.applyTick('222', 200);
      expect(flushSpy).not.toHaveBeenCalled(); // still debouncing

      jest.advanceTimersByTime(3_000);
      expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('ignores empty tokens and non-positive ltp', async () => {
      const flushSpy = jest.spyOn(service, 'flushTicks').mockResolvedValue(undefined);
      service.applyTick('', 100);
      service.applyTick('111', 0);
      service.applyTick('111', -5);
      jest.advanceTimersByTime(3_000);
      expect(flushSpy).not.toHaveBeenCalled();
    });

    it('flushTicks writes the computed patch for every OPEN tracker on the token', async () => {
      prisma.tradeTracker.findMany.mockResolvedValue([
        tracker({ id: 'a', token: '111', entryPrice: 100, qty: 10, holdingHigh: 100, holdingLow: 100 }),
      ]);
      service.applyTick('111', 130);

      await service.flushTicks();

      expect(prisma.tradeTracker.findMany).toHaveBeenCalledWith({
        where: { status: 'OPEN', token: { in: ['111'] } },
      });
      const call = prisma.tradeTracker.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'a', userId: 'user_1' });
      expect(call.data).toMatchObject({
        holdingHigh: 130,
        lastLtp: 130,
        pnl: 300, // (130-100)*10
        pnlPercent: 30,
      });
    });

    it('flushTicks is a no-op when nothing is pending', async () => {
      await service.flushTicks();
      expect(prisma.tradeTracker.findMany).not.toHaveBeenCalled();
    });
  });

  describe('list → DTO mapping', () => {
    it('maps rows to the §5 DTO with ISO dates and explicit nulls', async () => {
      const entryTime = new Date('2026-07-11T04:00:00.000Z');
      const updatedAt = new Date('2026-07-11T06:00:00.000Z');
      prisma.tradeTracker.findMany.mockResolvedValue([
        tracker({
          id: 'open_1',
          status: 'OPEN',
          entryTime,
          updatedAt,
          exitPrice: null,
          exitTime: null,
          holdingHigh: 120,
          holdingLow: 95,
          dayHigh: 118,
          dayLow: 110,
          lastLtp: 115,
          pnl: 150,
          pnlPercent: 15,
        }),
      ]);

      const dtos = await service.list('user_1');

      expect(prisma.tradeTracker.findMany).toHaveBeenCalledWith({
        where: { userId: 'user_1' },
        orderBy: { entryTime: 'desc' },
      });
      expect(dtos[0]).toEqual({
        id: 'open_1',
        symbol: 'INFY',
        exchange: 'NSE',
        token: '1594',
        kind: 'HOLDING',
        entryPrice: 100,
        qty: 10,
        entryTime: '2026-07-11T04:00:00.000Z',
        exitPrice: null,
        exitTime: null,
        status: 'OPEN',
        holdingHigh: 120,
        holdingLow: 95,
        dayHigh: 118,
        dayLow: 110,
        lastLtp: 115,
        pnl: 150,
        pnlPercent: 15,
        updatedAt: '2026-07-11T06:00:00.000Z',
      });
    });

    it('emits ISO exit fields for a CLOSED tracker', async () => {
      const exitTime = new Date('2026-07-11T09:00:00.000Z');
      prisma.tradeTracker.findMany.mockResolvedValue([
        tracker({ status: 'CLOSED', exitPrice: 130, exitTime }),
      ]);
      const [dto] = await service.list('user_1');
      expect(dto.status).toBe('CLOSED');
      expect(dto.exitPrice).toBe(130);
      expect(dto.exitTime).toBe('2026-07-11T09:00:00.000Z');
    });
  });
});
