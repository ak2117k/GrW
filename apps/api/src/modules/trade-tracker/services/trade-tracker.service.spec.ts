import { Logger } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TradeTracker } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CREDENTIAL_DECRYPTOR } from '../../credential-vault/execution/credential-decryptor';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';
import { AngelOneAuthService } from '../../market-data/services/angel-one-auth.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import {
  TradeTrackerService,
  computeOhlcWindow,
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

  describe('computeOhlcWindow', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = new Date('2026-07-13T00:00:00.000Z');

    it('spans (entry − 3d) → (exit + 10d) when the tail stays before now', () => {
      const entry = new Date('2026-06-01T00:00:00.000Z');
      const exit = new Date('2026-06-20T00:00:00.000Z');
      const { from, to } = computeOhlcWindow(entry, exit, now);
      expect(from.getTime()).toBe(entry.getTime() - 3 * DAY);
      expect(to.getTime()).toBe(exit.getTime() + 10 * DAY);
    });

    it('falls back to a 30-day pre-exit lookback when entryTime is null', () => {
      const exit = new Date('2026-06-20T00:00:00.000Z');
      const { from, to } = computeOhlcWindow(null, exit, now);
      // base = exit − 30d, then − 3d pad
      expect(from.getTime()).toBe(exit.getTime() - 30 * DAY - 3 * DAY);
      expect(to.getTime()).toBe(exit.getTime() + 10 * DAY);
    });

    it('clamps the post-exit tail to now', () => {
      const entry = new Date('2026-07-05T00:00:00.000Z');
      const exit = new Date('2026-07-12T00:00:00.000Z'); // exit + 10d is well past now
      const { from, to } = computeOhlcWindow(entry, exit, now);
      expect(from.getTime()).toBe(entry.getTime() - 3 * DAY);
      expect(to.getTime()).toBe(now.getTime()); // clamped
    });

    it('uses now as the exit anchor when exitTime is null', () => {
      const entry = new Date('2026-07-01T00:00:00.000Z');
      const { from, to } = computeOhlcWindow(entry, null, now);
      expect(from.getTime()).toBe(entry.getTime() - 3 * DAY);
      // exit anchor = now → tail would be now + 10d, clamped back to now
      expect(to.getTime()).toBe(now.getTime());
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
      findFirst: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
    brokerCredential: { findMany: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let decryptor: { withDecryptedCredentials: jest.Mock };
  let brokerFactory: { withSession: jest.Mock };
  let adapter: { getHistoricalData: jest.Mock };

  beforeEach(async () => {
    prisma = {
      tradeTracker: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      brokerCredential: { findMany: jest.fn().mockResolvedValue([]) },
      // Default: not the feed account → snapshotBook takes the ephemeral path.
      user: { findUnique: jest.fn().mockResolvedValue({ isFeedAccount: false }) },
    };
    decryptor = { withDecryptedCredentials: jest.fn() };
    brokerFactory = { withSession: jest.fn() };
    adapter = { getHistoricalData: jest.fn().mockResolvedValue([]) };
    const authService = { isAuthenticated: () => false, getSmartApi: () => null };

    const mod = await Test.createTestingModule({
      providers: [
        TradeTrackerService,
        { provide: PrismaService, useValue: prisma },
        { provide: CREDENTIAL_DECRYPTOR, useValue: decryptor },
        { provide: PerUserBrokerSessionFactory, useValue: brokerFactory },
        { provide: AngelOneAuthService, useValue: authService },
        { provide: AngelOneAdapterService, useValue: adapter },
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

    describe('an UNANSWERED broker read must never close a position', () => {
      // THE BUG THIS EXISTS FOR, and it destroyed real data.
      //
      // `UserBrokerSession.read` returns `response?.data ?? null`, so a failed or
      // unauthenticated broker call yields NULL — it does not throw. By the time
      // it reaches the close loop, `normalizePositions(null)` has turned it into
      // `[]`, which is byte-identical to "the broker says you hold nothing".
      //
      // The tracker then closed every open row and the next good fetch recreated
      // them with NEW IDS — orphaning the sentinel's verdicts and theses, and
      // resetting holdingHigh/holdingLow and entryTime. The broker positions
      // were never touched, which is exactly why nobody noticed.

      it('leaves POSITION trackers OPEN when the positions read returned null', async () => {
        prisma.tradeTracker.findMany.mockResolvedValue([
          tracker({ id: 'live_pos', token: '111', kind: 'POSITION' }),
        ]);

        await service.reconcile('user_1', null as never, []);

        expect(prisma.tradeTracker.updateMany).not.toHaveBeenCalled();
      });

      it('leaves HOLDING trackers OPEN when the holdings read returned null', async () => {
        prisma.tradeTracker.findMany.mockResolvedValue([
          tracker({ id: 'live_hold', token: '1594', kind: 'HOLDING' }),
        ]);

        await service.reconcile('user_1', [], null as never);

        expect(prisma.tradeTracker.updateMany).not.toHaveBeenCalled();
      });

      it('still closes the kind that WAS answered — one broken read does not freeze the other', async () => {
        prisma.tradeTracker.findMany.mockResolvedValue([
          tracker({ id: 'pos_unanswered', token: '111', kind: 'POSITION' }),
          tracker({ id: 'hold_answered', token: '1594', kind: 'HOLDING', lastLtp: 1200, entryPrice: 1000, qty: 10 }),
        ]);

        // Positions unanswered, holdings genuinely empty.
        await service.reconcile('user_1', null as never, []);

        expect(prisma.tradeTracker.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.tradeTracker.updateMany.mock.calls[0][0].where).toEqual({
          id: 'hold_answered',
          userId: 'user_1',
        });
      });

      it('DOES close on a genuinely empty answer — [] is an answer, null is not', async () => {
        // The other half of the distinction: without this, "never close" would
        // be a safe-looking fix that silently stops tracking exits entirely.
        prisma.tradeTracker.findMany.mockResolvedValue([
          tracker({ id: 'really_gone', token: '111', kind: 'POSITION' }),
        ]);

        await service.reconcile('user_1', [], []);

        expect(prisma.tradeTracker.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.tradeTracker.updateMany.mock.calls[0][0].data).toMatchObject({
          status: 'CLOSED',
        });
      });

      it('says so at WARN, so a session broken all day cannot look like a calm one', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        prisma.tradeTracker.findMany.mockResolvedValue([]);

        await service.reconcile('user_1', null as never, []);

        const logged = warn.mock.calls.map((c) => String(c[0])).join('');
        expect(logged).toMatch(/POSITION/);
        expect(logged).toMatch(/no answer/i);
        warn.mockRestore();
      });
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

  describe('listSold', () => {
    it('queries CLOSED only, newest exit first, scoped to the caller', async () => {
      prisma.tradeTracker.findMany.mockResolvedValue([]);
      await service.listSold('user_7');
      expect(prisma.tradeTracker.findMany).toHaveBeenCalledWith({
        where: { userId: 'user_7', status: 'CLOSED' },
        orderBy: { exitTime: 'desc' },
      });
    });

    it('maps a CLOSED row to the sold DTO with ISO dates and explicit nulls', async () => {
      const exitTime = new Date('2026-07-11T09:00:00.000Z');
      prisma.tradeTracker.findMany.mockResolvedValue([
        tracker({
          id: 'sold_1',
          status: 'CLOSED',
          kind: 'HOLDING',
          entryPrice: 100,
          qty: 10,
          exitPrice: 130,
          exitTime,
          pnl: 300,
          pnlPercent: 30,
          holdingHigh: 140,
          holdingLow: 95,
        }),
      ]);

      const [dto] = await service.listSold('user_1');

      expect(dto).toEqual({
        id: 'sold_1',
        symbol: 'INFY',
        exchange: 'NSE',
        token: '1594',
        kind: 'HOLDING',
        entryPrice: 100,
        qty: 10,
        exitPrice: 130,
        exitTime: '2026-07-11T09:00:00.000Z',
        pnl: 300,
        pnlPercent: 30,
        holdingHigh: 140,
        holdingLow: 95,
      });
      // No open-book fields leak into the sold contract.
      expect(dto).not.toHaveProperty('dayHigh');
      expect(dto).not.toHaveProperty('lastLtp');
      expect(dto).not.toHaveProperty('status');
    });

    it('maps null exit/pnl/extremes to null (never undefined)', async () => {
      prisma.tradeTracker.findMany.mockResolvedValue([
        tracker({
          status: 'CLOSED',
          exitPrice: null,
          exitTime: null,
          pnl: null,
          pnlPercent: null,
          holdingHigh: null,
          holdingLow: null,
        }),
      ]);
      const [dto] = await service.listSold('user_1');
      expect(dto.exitPrice).toBeNull();
      expect(dto.exitTime).toBeNull();
      expect(dto.pnl).toBeNull();
      expect(dto.pnlPercent).toBeNull();
      expect(dto.holdingHigh).toBeNull();
      expect(dto.holdingLow).toBeNull();
    });
  });

  describe('listSoldOhlc', () => {
    it('404s when the tracker is not the caller’s', async () => {
      prisma.tradeTracker.findFirst.mockResolvedValue(null);
      await expect(service.listSoldOhlc('user_1', 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.tradeTracker.findFirst).toHaveBeenCalledWith({
        where: { id: 'nope', userId: 'user_1' },
      });
      expect(adapter.getHistoricalData).not.toHaveBeenCalled();
    });

    it('fetches DAILY candles over the window and maps them to the OHLC DTO', async () => {
      const entryTime = new Date('2026-06-01T04:00:00.000Z');
      const exitTime = new Date('2026-06-20T09:00:00.000Z');
      prisma.tradeTracker.findFirst.mockResolvedValue(
        tracker({
          id: 'sold_1',
          symbol: 'INFY',
          exchange: 'NSE',
          token: '1594',
          status: 'CLOSED',
          entryTime,
          exitTime,
        }),
      );
      adapter.getHistoricalData.mockResolvedValue([
        { timestamp: '2026-06-02T00:00:00.000Z', open: '100', high: '110', low: '95', close: '105' },
        { timestamp: '2026-06-03T00:00:00.000Z', open: 105, high: 112, low: 104, close: 109 },
      ]);

      const res = await service.listSoldOhlc('user_1', 'sold_1');

      // token + exchange + DAILY interval, in that arg order.
      expect(adapter.getHistoricalData).toHaveBeenCalledTimes(1);
      const [token, exchange, interval, from, to] =
        adapter.getHistoricalData.mock.calls[0];
      expect(token).toBe('1594');
      expect(exchange).toBe('NSE');
      expect(interval).toBe('ONE_DAY');
      const DAY = 24 * 60 * 60 * 1000;
      expect((from as Date).getTime()).toBe(entryTime.getTime() - 3 * DAY);
      expect((to as Date).getTime()).toBe(exitTime.getTime() + 10 * DAY);

      expect(res.symbol).toBe('INFY');
      expect(res.ohlc).toEqual([
        { date: '2026-06-02T00:00:00.000Z', open: 100, high: 110, low: 95, close: 105 },
        { date: '2026-06-03T00:00:00.000Z', open: 105, high: 112, low: 104, close: 109 },
      ]);
    });

    it('degrades to an empty series when the adapter throws (never 500s)', async () => {
      prisma.tradeTracker.findFirst.mockResolvedValue(
        tracker({ id: 'sold_1', symbol: 'INFY', status: 'CLOSED', exitTime: new Date() }),
      );
      adapter.getHistoricalData.mockRejectedValue(new Error('angel down'));

      const res = await service.listSoldOhlc('user_1', 'sold_1');

      expect(res).toEqual({ symbol: 'INFY', ohlc: [] });
    });

    it('degrades to an empty series when the adapter returns a non-array', async () => {
      prisma.tradeTracker.findFirst.mockResolvedValue(
        tracker({ id: 'sold_1', symbol: 'INFY', status: 'CLOSED', exitTime: new Date() }),
      );
      adapter.getHistoricalData.mockResolvedValue(null);

      const res = await service.listSoldOhlc('user_1', 'sold_1');

      expect(res).toEqual({ symbol: 'INFY', ohlc: [] });
    });
  });
});
