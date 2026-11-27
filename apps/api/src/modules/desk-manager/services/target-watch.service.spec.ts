import { Logger } from '@nestjs/common';
import { parseDeskManagerConfig } from '../desk-manager.config';
import { TARGET_LOCK_AFTER_MS, TARGET_LOCK_RUN_ID, TargetWatchService, entryRefOf } from './target-watch.service';

const T0 = new Date('2026-11-26T05:00:00Z'); // 10:30 IST
const at = (ms: number) => new Date(T0.getTime() + ms);
const OWNER = 'owner';

type Row = Record<string, any>;

/** An OPEN decision filled into live tracker t1: BSE BUY_CE, stop 3863, targets 3950 / 4000, underlying entry 3890. */
const openRow = (over: Row = {}): Row => ({
  id: 'd-open', runId: 'run1', userId: OWNER, action: 'OPEN', underlying: 'BSE', trackerId: 't1', orderRowId: 'o1', tradeId: null,
  status: 'DONE', createdAt: at(-30 * 60_000), result: { underlyingEntry: 3890 },
  payload: { action: 'OPEN', underlying: 'BSE', side: 'BUY_CE', stop: { underlying: 3863 }, targets: { underlying: [4000, 3950] }, entry: { type: 'NOW', validMin: 5 } },
  ...over,
});

function harness(o: { rows?: Row[]; answered?: number; ltp?: () => number; trade?: Row; tracker?: Row | null } = {}) {
  let ltp = o.ltp ?? (() => 3900);
  const decisions: Row[] = [...(o.rows ?? [openRow()])];
  const prisma = {
    deskManagerDecision: {
      findMany: jest.fn(async () => decisions.filter((d) => ['OPEN', 'TIGHTEN'].includes(d.action) && ['DONE', 'RECORDED'].includes(d.status))),
      count: jest.fn(async () => o.answered ?? 0),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: `d-lock-${decisions.length}`, createdAt: new Date(), ...data };
        decisions.push(row);
        return { id: row.id };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(decisions.find((d) => d.id === where.id)!, data)),
    },
    signalOrder: { findMany: jest.fn(async () => [{ id: 'o1', trackerId: 't1' }]) },
    tradeTracker: {
      findMany: jest.fn(async () => (o.tracker === null ? [] : [o.tracker ?? { id: 't1', symbol: 'BSE30DEC253900CE', exchange: 'NFO', qty: 375, entryPrice: 80 }])),
    },
    trade: { findMany: jest.fn(async () => (o.trade ? [o.trade] : [])) },
    deskManagerRun: { findMany: jest.fn(async () => []) },
  };
  const exits = {
    tighten: jest.fn(async () => ({ status: 'RECORDED', detail: 'stop proposed', ref: 'v1' })),
    closePaper: jest.fn(async () => ({ status: 'DONE', detail: 'closed' })),
  };
  const market = {
    underlyingRef: jest.fn(async (u: string) => ({ exchange: 'NSE', token: '19585', symbol: u })),
    ltps: jest.fn(async () => new Map([['NSE:19585', ltp()]])),
  };
  const wake = { wake: jest.fn() };
  const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'live', HUB_OWNER_USER_ID: OWNER });
  const svc = new TargetWatchService(prisma as never, exits as never, cfg, market as never, wake);
  return { svc, prisma, exits, market, wake, decisions, setLtp: (f: () => number) => { ltp = f; } };
}

describe('TargetWatchService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('loads a filled OPEN: tracker via its order, targets ordered in its favour, stop and entry reference', async () => {
    const h = harness();
    const [p] = await h.svc.load(OWNER, T0);
    expect(p).toEqual(expect.objectContaining({ trackerId: 't1', underlying: 'BSE', bullish: true, targets: [3950, 4000], stop: 3863, entryRef: 3890, qty: 375 }));
  });

  it('target crossed wakes the manager and locks after 60 s', async () => {
    const h = harness();
    await h.svc.pass(T0); // 3900: below target 1
    expect(h.wake.wake).not.toHaveBeenCalled();
    h.setLtp(() => 3952);
    await h.svc.pass(at(5_000));
    expect(h.wake.wake).toHaveBeenCalledWith('target_crossed', at(5_000));
    await h.svc.pass(at(30_000));
    expect(h.exits.tighten).not.toHaveBeenCalled(); // the manager still has time
    await h.svc.pass(at(5_000 + TARGET_LOCK_AFTER_MS));
    // First target ⇒ locked to the entry 3890 (tighter than the 3863 stop), as a target-lock TIGHTEN decision.
    expect(h.exits.tighten).toHaveBeenCalledTimes(1);
    const [trackerId, level, reason, ctx] = h.exits.tighten.mock.calls[0] as unknown as [string, number, string, any];
    expect([trackerId, level]).toEqual(['t1', 3890]);
    expect(reason).toMatch(/target lock: BSE crossed target 1 \(3950\)/);
    expect(ctx.packet.positions.value[0]).toEqual(expect.objectContaining({ trackerId: 't1', managerStop: 3863, underlying: 'BSE' }));
    const lock = h.decisions.find((d) => d.runId === TARGET_LOCK_RUN_ID)!;
    expect(lock).toEqual(expect.objectContaining({ action: 'TIGHTEN', trackerId: 't1', status: 'RECORDED' }));
    expect(lock.payload.underlyingStop).toBe(3890);
    // Once per crossing.
    await h.svc.pass(at(10_000 + TARGET_LOCK_AFTER_MS));
    expect(h.exits.tighten).toHaveBeenCalledTimes(1);
  });

  it('second target locks to the first target', async () => {
    const h = harness({ ltp: () => 4001 });
    await h.svc.pass(T0); // both crossed at once
    await h.svc.pass(at(TARGET_LOCK_AFTER_MS));
    expect((h.exits.tighten.mock.calls[0] as unknown[])[1]).toBe(3950);
  });

  it('the manager answering within 60 s means no lock', async () => {
    const h = harness({ ltp: () => 3952, answered: 1 });
    await h.svc.pass(T0);
    await h.svc.pass(at(TARGET_LOCK_AFTER_MS));
    expect(h.exits.tighten).not.toHaveBeenCalled();
    const where = (h.prisma.deskManagerDecision.count.mock.calls[0] as any)[0].where;
    expect(where).toEqual(expect.objectContaining({ trackerId: 't1', action: { in: ['EXIT', 'BOOK', 'TIGHTEN'] }, runId: { not: TARGET_LOCK_RUN_ID }, createdAt: { gte: T0 } }));
  });

  it('lock never loosens: a manager stop already past the lock level stays', async () => {
    const tightened = { id: 'd-t', runId: 'run2', userId: OWNER, action: 'TIGHTEN', trackerId: 't1', status: 'RECORDED', createdAt: at(-60_000), payload: { underlyingStop: 3920 } };
    const looser = { ...tightened, id: 'd-t2', payload: { underlyingStop: 3870 } };
    const h = harness({ rows: [openRow(), tightened, looser], ltp: () => 3952 });
    expect((await h.svc.load(OWNER, T0))[0].stop).toBe(3920); // tightest wins, never the later looser one
    await h.svc.pass(T0);
    await h.svc.pass(at(TARGET_LOCK_AFTER_MS));
    expect(h.exits.tighten).not.toHaveBeenCalled(); // 3890 (entry) is looser than 3920
  });

  it('a PE position: targets below, crossing downward, lock above', async () => {
    const pe = openRow({ payload: { underlying: 'BSE', side: 'BUY_PE', stop: { underlying: 3950 }, targets: { underlying: [3850, 3800] }, entry: { type: 'NOW' } } });
    const h = harness({ rows: [pe], ltp: () => 3845, tracker: { id: 't1', symbol: 'BSE30DEC253900PE', exchange: 'NFO', qty: 375, entryPrice: 80 } });
    await h.svc.pass(T0);
    await h.svc.pass(at(TARGET_LOCK_AFTER_MS));
    expect(h.wake.wake).toHaveBeenCalledTimes(1);
    expect((h.exits.tighten.mock.calls[0] as unknown[])[1]).toBe(3890);
  });

  it('a closed tracker is not watched', async () => {
    const h = harness({ tracker: null, ltp: () => 4100 });
    await h.svc.pass(T0);
    expect(h.wake.wake).not.toHaveBeenCalled();
    expect(h.market.ltps).not.toHaveBeenCalled();
  });

  it('paper: the manager stop is enforced by a paper close', async () => {
    const paperOpen = openRow({ trackerId: null, orderRowId: null, tradeId: 'tr1' });
    const trade = { id: 'tr1', status: 'OPEN', side: 'BUY', quantity: 375, entryPrice: 80, instrument: { symbol: 'BSE30DEC253900CE', exchange: 'NFO' } };
    const h = harness({ rows: [paperOpen], trade, ltp: () => 3860 });
    await h.svc.pass(T0);
    expect(h.exits.closePaper).toHaveBeenCalledWith('tr1', 'DESK_MANAGER_STOP', expect.stringContaining('manager stop 3863'));
    expect(h.wake.wake).not.toHaveBeenCalled();
  });

  describe('trade agent exit authority', () => {
    const withAuthority = (live: boolean, o: Parameters<typeof harness>[0] = {}, raise: jest.Mock = jest.fn(async () => ({ id: 'alarm-1' }))) => {
      const h = harness(o);
      const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'live', HUB_OWNER_USER_ID: OWNER });
      const svc = new TargetWatchService(h.prisma as never, h.exits as never, cfg, h.market as never, h.wake, { raise }, { isLive: () => live });
      return { ...h, svc, raise };
    };

    it('live: a crossed target with the manager silent 60 s raises TARGET_LOCK (payload.level) instead of tightening', async () => {
      const h = withAuthority(true, { ltp: () => 3952 });
      await h.svc.pass(T0);
      expect(h.wake.wake).toHaveBeenCalledWith('target_crossed', T0);
      await h.svc.pass(at(TARGET_LOCK_AFTER_MS));
      expect(h.exits.tighten).not.toHaveBeenCalled();
      expect(h.prisma.deskManagerDecision.create).not.toHaveBeenCalled();
      expect(h.raise).toHaveBeenCalledTimes(1);
      const [alarm, when] = h.raise.mock.calls[0] as [Record<string, any>, Date];
      expect(alarm).toEqual(expect.objectContaining({ userId: OWNER, trackerId: 't1', symbol: 'BSE30DEC253900CE', rule: 'TARGET_LOCK', urgency: 'normal', sourceRef: 'd-open' }));
      expect(alarm.payload).toEqual(expect.objectContaining({ level: 3890, target: 3950, reached: 1 }));
      expect(alarm.reason).toMatch(/target lock: BSE crossed target 1 \(3950\)/);
      expect(when).toEqual(at(TARGET_LOCK_AFTER_MS));
      // Once per crossing, as the lock.
      await h.svc.pass(at(5_000 + TARGET_LOCK_AFTER_MS));
      expect(h.raise).toHaveBeenCalledTimes(1);
    });

    it('live: the alarm failing locks by code as today', async () => {
      const h = withAuthority(true, { ltp: () => 3952 }, jest.fn(async () => { throw new Error('db down'); }));
      await h.svc.pass(T0);
      await h.svc.pass(at(TARGET_LOCK_AFTER_MS));
      expect((h.exits.tighten.mock.calls[0] as unknown[])[1]).toBe(3890);
    });

    it('live: the manager paper trades keep the code lock', async () => {
      const paperOpen = openRow({ trackerId: null, orderRowId: null, tradeId: 'tr1' });
      const trade = { id: 'tr1', status: 'OPEN', side: 'BUY', quantity: 375, entryPrice: 80, instrument: { symbol: 'BSE30DEC253900CE', exchange: 'NFO' } };
      const h = withAuthority(true, { rows: [paperOpen], trade, ltp: () => 3952 });
      await h.svc.pass(T0);
      await h.svc.pass(at(TARGET_LOCK_AFTER_MS));
      expect(h.raise).not.toHaveBeenCalled();
      expect(h.exits.tighten).toHaveBeenCalledTimes(1);
    });

    it('off (isLive false): today\'s lock, no alarm', async () => {
      const h = withAuthority(false, { ltp: () => 3952 });
      await h.svc.pass(T0);
      await h.svc.pass(at(TARGET_LOCK_AFTER_MS));
      expect(h.raise).not.toHaveBeenCalled();
      expect(h.exits.tighten).toHaveBeenCalledTimes(1);
    });
  });

  it('mode off does nothing', async () => {
    const h = harness();
    const svc = new TargetWatchService(h.prisma as never, h.exits as never, parseDeskManagerConfig({ HUB_OWNER_USER_ID: OWNER }), h.market as never, h.wake);
    await svc.pass(T0);
    expect(h.prisma.deskManagerDecision.findMany).not.toHaveBeenCalled();
  });

  it('entryRefOf: executor result, else zone mid / breakout trigger, else the decision packet LTP', () => {
    expect(entryRefOf({ underlyingEntry: 3890 }, {}, null, 'BSE')).toBe(3890);
    expect(entryRefOf(null, { entry: { type: 'ZONE', low: 3880, high: 3900 } }, null, 'BSE')).toBe(3890);
    expect(entryRefOf(null, { entry: { type: 'BREAKOUT', triggerAbove: 3905 } }, null, 'BSE')).toBe(3905);
    const packet = { instruments: { status: 'present', value: { BSE: { ltp: 3894 } } } };
    expect(entryRefOf(null, { entry: { type: 'NOW' } }, packet, 'BSE')).toBe(3894);
    expect(entryRefOf(null, { entry: { type: 'NOW' } }, null, 'BSE')).toBeNull();
  });
});
