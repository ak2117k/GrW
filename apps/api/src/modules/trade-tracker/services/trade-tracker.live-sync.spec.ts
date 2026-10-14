import { Logger } from '@nestjs/common';
import type { TradeTracker } from '@prisma/client';
import { TradeTrackerService, istDateString } from './trade-tracker.service';

/**
 * TradeTrackerService support for near-live broker sync: the positions-only,
 * warm-session-only reconcile the order stream and the adaptive poll call, the
 * per-user single flight every reconcile path shares, and the open-set change
 * event the market hub listens to.
 */

function tracker(overrides: Partial<TradeTracker> = {}): TradeTracker {
  const now = new Date('2026-10-13T04:00:00.000Z');
  return {
    id: 'trk_1',
    userId: 'u1',
    symbol: 'SYM111',
    exchange: 'NFO',
    token: '111',
    kind: 'POSITION',
    entryPrice: 100,
    qty: 25,
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

const pos = (token: string) => ({
  symboltoken: token,
  tradingsymbol: `SYM${token}`,
  exchange: 'NFO',
  netqty: '25',
  avgnetprice: '100',
  ltp: '110',
});

function build(opts: { warm?: boolean; positions?: unknown; holdings?: unknown; open?: TradeTracker[] } = {}) {
  const warmClient = {
    getPosition: jest.fn(async (): Promise<unknown> => opts.positions ?? { status: true, data: [] }),
    getAllHolding: jest.fn(async (): Promise<unknown> => opts.holdings ?? { status: true, data: { holdings: [] } }),
  };
  const release = jest.fn();
  const userFeeds = {
    leaseRestClient: jest.fn(() => (opts.warm ? { client: warmClient, clientId: 'U123', release } : null)),
    hasSession: jest.fn(() => !!opts.warm),
  };
  const factory = {
    borrow: jest.fn((client: typeof warmClient, _id: string, fn: (s: unknown) => unknown) =>
      fn({ getPositionsEnvelope: () => client.getPosition(), getHoldingsEnvelope: () => client.getAllHolding() }),
    ),
    withSession: jest.fn(),
  };
  const decryptor = { withDecryptedCredentials: jest.fn() };
  const authService = { isAuthenticated: () => false, getSmartApi: () => null, getClientId: () => '' };
  const prisma = {
    tradeTracker: {
      findMany: jest.fn().mockResolvedValue(opts.open ?? []),
      create: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const service = new TradeTrackerService(
    prisma as never,
    decryptor as never,
    factory as never,
    authService as never,
    {} as never,
    userFeeds as never,
  );
  return { service, prisma, warmClient, userFeeds, factory, decryptor, release };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('TradeTrackerService — live broker sync support', () => {
  describe('backfill({ positionsOnly, warmOnly })', () => {
    it('reads ONLY positions over the warm session: no holdings call, no login, no decrypt', async () => {
      const h = build({ warm: true, positions: { status: true, data: [pos('111')] } });

      const r = await h.service.backfill('u1', { positionsOnly: true, warmOnly: true });

      expect(h.warmClient.getPosition).toHaveBeenCalledTimes(1);
      expect(h.warmClient.getAllHolding).not.toHaveBeenCalled();
      expect(h.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
      expect(h.factory.withSession).not.toHaveBeenCalled();
      expect(h.release).toHaveBeenCalled();
      expect(h.prisma.tradeTracker.create).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ opened: 1, closed: 0 });
    });

    it('with no warm session it does NOTHING (never a second login) and touches no tracker', async () => {
      const h = build({ warm: false, open: [tracker()] });

      const r = await h.service.backfill('u1', { positionsOnly: true, warmOnly: true });

      expect(h.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
      expect(h.factory.withSession).not.toHaveBeenCalled();
      expect(h.prisma.tradeTracker.findMany).not.toHaveBeenCalled();
      expect(h.prisma.tradeTracker.updateMany).not.toHaveBeenCalled();
      expect(r).toMatchObject({ opened: 0, closed: 0, skipped: true });
    });

    it('a positions-only pass never closes HOLDING trackers and does not warn about holdings', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const h = build({ warm: true, open: [tracker({ id: 'hold', token: '1594', kind: 'HOLDING', exchange: 'NSE' })] });

      await h.service.backfill('u1', { positionsOnly: true, warmOnly: true });

      expect(h.prisma.tradeTracker.updateMany).not.toHaveBeenCalled();
      expect(warn.mock.calls.some(([m]) => /no answer for HOLDING/.test(String(m)))).toBe(false);
      warn.mockRestore();
    });

    it.each([
      ['status false (AG8001)', { status: false, errorcode: 'AG8001', data: null }],
      ['an HTTP-error object', { status: 500, message: 'Error' }],
      ['null', null],
    ])('a FAILED positions read (%s) never closes an OPEN position tracker', async (_l, envelope) => {
      const h = build({ warm: true, positions: envelope, open: [tracker()] });
      h.warmClient.getPosition.mockResolvedValue(envelope);

      const r = await h.service.backfill('u1', { positionsOnly: true, warmOnly: true });

      expect(h.prisma.tradeTracker.updateMany).not.toHaveBeenCalled();
      expect(r).toMatchObject({ closed: 0 });
    });

    it('an answered book without the position closes it and reports the change', async () => {
      const h = build({ warm: true, positions: { status: true, data: [] }, open: [tracker()] });

      const r = await h.service.backfill('u1', { positionsOnly: true, warmOnly: true });

      expect(h.prisma.tradeTracker.updateMany.mock.calls[0][0]).toMatchObject({ data: { status: 'CLOSED' } });
      expect(r).toMatchObject({ opened: 0, closed: 1 });
    });
  });

  describe('single flight per user', () => {
    it('never runs two reconciles for one user at once; requests during a run coalesce into ONE trailing run', async () => {
      const h = build({ warm: true });
      let inFlight = 0;
      let maxInFlight = 0;
      const gates: Array<() => void> = [];
      h.warmClient.getPosition.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => gates.push(resolve));
        inFlight--;
        return { status: true, data: [] };
      });

      const first = h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      expect(h.service.isBackfilling('u1')).toBe(true);
      const second = h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      const third = h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      expect(third).toBe(second);

      await flush();
      gates.shift()!();
      await first;
      await flush();
      gates.shift()!();
      await Promise.all([second, third]);

      expect(h.warmClient.getPosition).toHaveBeenCalledTimes(2);
      expect(maxInFlight).toBe(1);
      expect(h.service.isBackfilling('u1')).toBe(false);
    });

    it('other users are not serialized behind one user', async () => {
      const h = build({ warm: true });
      h.warmClient.getPosition.mockImplementationOnce(() => new Promise(() => undefined)); // u1 hangs
      void h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      await expect(h.service.backfill('u2', { positionsOnly: true, warmOnly: true })).resolves.toMatchObject({ skipped: false });
    });

    it('a full request queued behind a positions-only one upgrades the trailing run to read holdings too', async () => {
      const h = build({ warm: true });
      let release!: () => void;
      h.warmClient.getPosition.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ status: true, data: [] });
          }),
      );
      const first = h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      const queued = h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      const full = h.service.backfill('u1');
      expect(full).toBe(queued);
      await flush();
      release();
      await Promise.all([first, full]);
      expect(h.warmClient.getAllHolding).toHaveBeenCalledTimes(1);
    });

    it('a failed run does not wedge the user: the queued run still happens', async () => {
      const h = build({ warm: true });
      h.warmClient.getPosition.mockRejectedValueOnce(new Error('socket hang up'));
      const first = h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      const second = h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      await expect(first).rejects.toThrow('socket hang up');
      await expect(second).resolves.toMatchObject({ skipped: false });
      expect(h.service.isBackfilling('u1')).toBe(false);
    });
  });

  describe('onOpenSetChanged', () => {
    it('fires with the user when a reconcile opens or closes a tracker, and not otherwise', async () => {
      const h = build({ warm: true, positions: { status: true, data: [pos('111')] } });
      const seen: string[] = [];
      const off = h.service.onOpenSetChanged((userId) => seen.push(userId));

      await h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      expect(seen).toEqual(['u1']);

      h.prisma.tradeTracker.findMany.mockResolvedValue([tracker()]);
      await h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      expect(seen).toEqual(['u1']); // unchanged book: no event

      off();
      h.warmClient.getPosition.mockResolvedValue({ status: true, data: [] });
      await h.service.backfill('u1', { positionsOnly: true, warmOnly: true });
      expect(seen).toEqual(['u1']); // unsubscribed
    });

    it('a throwing listener never breaks the reconcile', async () => {
      const h = build({ warm: true, positions: { status: true, data: [pos('111')] } });
      h.service.onOpenSetChanged(() => {
        throw new Error('boom');
      });
      await expect(h.service.backfill('u1', { positionsOnly: true, warmOnly: true })).resolves.toMatchObject({
        opened: 1,
      });
    });
  });

  describe('openPositionExchangesByUser', () => {
    it('groups the exchanges of OPEN POSITION trackers by user (holdings excluded by the query)', async () => {
      const h = build();
      h.prisma.tradeTracker.findMany.mockResolvedValue([
        { userId: 'u1', exchange: 'nfo' },
        { userId: 'u1', exchange: 'MCX' },
        { userId: 'u2', exchange: 'NSE' },
      ]);
      const r = await h.service.openPositionExchangesByUser();
      expect(h.prisma.tradeTracker.findMany.mock.calls[0][0]).toMatchObject({
        where: { status: 'OPEN', kind: 'POSITION' },
      });
      expect([...r.get('u1')!].sort()).toEqual(['MCX', 'NFO']);
      expect([...r.get('u2')!]).toEqual(['NSE']);
    });
  });
});
