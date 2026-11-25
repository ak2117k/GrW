import { FloorBrokerSlService } from './floor-broker-sl.service';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { floorStopTag, parseFloorBrokerSlConfig } from '../domain/floor-broker-sl';
import type { FloorState } from '../../floor-board/floor-state.board';
import type { FloorSlTracker } from '../repositories/floor-broker-sl.repository';

const T0 = new Date('2026-11-06T05:00:00Z').getTime();
const at = (sec: number) => new Date(T0 + sec * 1000);
const EXIT = parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'true' });
const SHADOW = parseFloorBrokerSlConfig({}, EXIT);
const LIVE = parseFloorBrokerSlConfig({ FLOOR_BROKER_SL: 'live' }, EXIT);

const tracker = (over: Partial<FloorSlTracker> = {}): FloorSlTracker => ({
  id: 't1', userId: 'owner', symbol: 'NIFTY09NOV2624650CE', exchange: 'NFO', token: '40009', qty: 130, status: 'OPEN', kind: 'POSITION',
  entryTime: new Date(T0 - 600_000), exitPrice: null, exitTime: null, ...over,
});
const state = (over: Partial<FloorState> = {}): FloorState => ({
  trackerId: 't1', userId: 'owner', symbol: 'NIFTY09NOV2624650CE', exchange: 'NFO', ownership: 'SENTINEL', side: 'LONG',
  entryPrice: 150, ltp: 186, floor: { basis: 'noise', armed: true, level: 180.74 }, at: T0, ...over,
});

function harness() {
  const rows: any[] = [];
  let open: FloorSlTracker[] = [tracker()];
  let closed: FloorSlTracker[] = [];
  let board: FloorState | null = state();
  const repo = {
    record: jest.fn(async (e: any) => { rows.push({ ...e, createdAt: e.createdAt ?? new Date(Date.now()) }); }),
    openTrackers: jest.fn(async () => open),
    trackers: jest.fn(async (ids: string[]) => [...open, ...closed].filter((t) => ids.includes(t.id))),
    instrument: jest.fn(async () => ({ tickSize: 5, lotSize: 65 })),
    stopHistory: jest.fn(async (_m: string, _s: Date, ids?: string[]) => rows
      .filter((r) => ['PLACE', 'MODIFY', 'CANCEL'].includes(r.action) && (!ids || ids.includes(r.trackerId)))
      .map((r) => ({ ...r, createdAt: r.at ?? r.createdAt }))),
    pendingCompares: jest.fn(async () => [...new Set(rows.filter((r) => r.action === 'PLACE').map((r) => r.trackerId))]
      .filter((id) => !rows.some((r) => r.action === 'EXIT_COMPARE' && r.trackerId === id))),
    exitFill: jest.fn(async () => null as null | { fillPrice: number; fillAt: Date }),
  };
  const executor = { syncFloorStops: jest.fn(async (_u: string, intents: any[]) => intents.map((i) => ({ trackerId: i.trackerId, action: 'PLACE', trigger: 180.75, limit: 180.6, quantity: 130, side: 'SELL', orderId: 'SL9' }))) };
  const clock = { isOpen: jest.fn(() => true) };
  const candles = { read: jest.fn(async () => [] as any[]) };
  const svc = new FloorBrokerSlService(repo as never, executor as never, clock as never, candles as never, { get: () => board } as never);
  return {
    svc, repo, executor, candles, rows,
    set: (o: { open?: FloorSlTracker[]; closed?: FloorSlTracker[]; board?: FloorState | null }) => {
      if (o.open) open = o.open; if (o.closed) closed = o.closed; if (o.board !== undefined) board = o.board;
    },
    actions: () => rows.map((r) => `${r.action}${r.reason ? `:${r.reason}` : ''}`),
  };
}

describe('FloorBrokerSlService — shadow (default)', () => {
  it('records the stop it WOULD place and never calls the executor / broker', async () => {
    const h = harness();
    h.svc.use(EXIT, SHADOW);
    await h.svc.runOnce(at(0));
    expect(h.executor.syncFloorStops).not.toHaveBeenCalled();
    expect(h.rows[0]).toMatchObject({ mode: 'shadow', action: 'PLACE', side: 'SELL', triggerPrice: 180.75, limitPrice: 180.6, quantity: 130, floorPrice: 180.74, orderTag: floorStopTag('t1') });
  });

  it('trails up (≥ 1 tick, ≥ 15 s apart), never down, and cancels when the floor disarms', async () => {
    const h = harness();
    h.svc.use(EXIT, SHADOW);
    await h.svc.runOnce(at(0));
    h.set({ board: state({ floor: { basis: 'noise', armed: true, level: 183 }, ltp: 190, at: T0 + 5_000 }) });
    await h.svc.runOnce(at(5)); // rate-limited
    h.set({ board: state({ floor: { basis: 'noise', armed: true, level: 183 }, ltp: 190, at: T0 + 20_000 }) });
    await h.svc.runOnce(at(20));
    h.set({ board: state({ floor: { basis: 'noise', armed: true, level: 175 }, ltp: 190, at: T0 + 40_000 }) });
    await h.svc.runOnce(at(40)); // lower: nothing
    h.set({ board: state({ floor: { basis: 'noise', armed: false, level: 175 }, at: T0 + 60_000 }) });
    await h.svc.runOnce(at(60));
    expect(h.actions()).toEqual(['PLACE', 'MODIFY', 'CANCEL:FLOOR_DISARMED']);
    expect(h.rows[1]).toMatchObject({ triggerPrice: 183, prevTriggerPrice: 180.75 });
  });

  it('places nothing without a fresh SENTINEL-owned armed noise floor; skips are recorded once per reason', async () => {
    const h = harness();
    h.svc.use(EXIT, SHADOW);
    h.set({ board: state({ ownership: 'OBSERVE_ONLY' }) });
    await h.svc.runOnce(at(0));
    await h.svc.runOnce(at(15));
    h.set({ board: state({ at: T0 - 600_000 }) }); // stale: untouched
    await h.svc.runOnce(at(30));
    h.set({ board: state({ ltp: 180.7, at: T0 + 45_000 }) }); // already through the floor
    await h.svc.runOnce(at(45));
    expect(h.actions()).toEqual(['SKIP:NOT_SENTINEL_OWNED', 'SKIP:NOT_PLACEABLE']);
  });

  it('honours AI_AUTO_EXIT_HOLD and the allow-list', async () => {
    const h = harness();
    h.svc.use(parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_HOLD: 'nifty09nov2624650ce' }), SHADOW);
    await h.svc.runOnce(at(0));
    expect(h.actions()).toEqual(['SKIP:OWNER_HOLD']);
  });

  it('when the position closes: CANCEL POSITION_CLOSED, then EXIT_COMPARE of the stop fill vs the real exit', async () => {
    const h = harness();
    h.svc.use(EXIT, SHADOW);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await h.svc.runOnce(at(0));
    h.rows[0].at = at(0);
    const exited = tracker({ status: 'CLOSED', exitPrice: 167.6, exitTime: at(200) });
    h.set({ open: [], closed: [exited] });
    h.repo.exitFill.mockResolvedValue({ fillPrice: 167.6, fillAt: at(200) });
    h.candles.read.mockResolvedValue([
      { ts: T0 + 60_000, open: 186, high: 187, low: 182, close: 183, volume: 0 },
      { ts: T0 + 120_000, open: 183, high: 183, low: 170, close: 171, volume: 0 },
    ]);
    await h.svc.runOnce(at(210)); // closes the virtual stop (compare waits for COMPARE_DELAY)
    await h.svc.runOnce(at(400));
    await h.svc.runOnce(at(415));
    await h.svc.runOnce(at(430));
    await h.svc.runOnce(at(445)); // pass 5 runs the compare
    nowSpy.mockRestore();
    const cmp = h.rows.find((r) => r.action === 'EXIT_COMPARE');
    expect(h.actions()).toContain('CANCEL:POSITION_CLOSED');
    expect(cmp).toMatchObject({ exitPrice: 167.6, wouldFillPrice: 180.75, wouldFillLimit: 180.6, reason: 'TRADED_THROUGH' });
    expect(cmp.savedRupees).toBeCloseTo((180.75 - 167.6) * 130, 2);
    expect(cmp.detail.savedAtLimit).toBeCloseTo((180.6 - 167.6) * 130, 2);
  });

  it('restores its virtual stops after a restart (a MODIFY, not a second PLACE)', async () => {
    const h = harness();
    h.rows.push({ action: 'PLACE', trackerId: 't1', side: 'SELL', triggerPrice: 170, limitPrice: 169.85, quantity: 130, createdAt: at(-60) });
    h.svc.use(EXIT, SHADOW);
    await h.svc.runOnce(at(0));
    expect(h.actions()).toEqual(['PLACE', 'MODIFY']);
  });

  it('off does nothing at all', async () => {
    const h = harness();
    h.svc.use(EXIT, parseFloorBrokerSlConfig({ FLOOR_BROKER_SL: 'off' }, EXIT));
    await h.svc.runOnce(at(0));
    expect(h.repo.openTrackers).not.toHaveBeenCalled();
  });

  it('onModuleInit starts no timer with BOOT_JOBS=false or the auto-exit disabled', () => {
    const keep = { ...process.env };
    try {
      process.env.BOOT_JOBS = 'false';
      Object.assign(process.env, { AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
      const a = harness();
      const spy = jest.spyOn(global, 'setInterval');
      a.svc.onModuleInit();
      delete process.env.BOOT_JOBS;
      process.env.AI_AUTO_EXIT_ENABLED = 'false';
      harness().svc.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      process.env = keep;
    }
  });
});

describe('FloorBrokerSlService — FLOOR_BROKER_SL_AT=ceiling (the rupee ceiling, not the noise floor)', () => {
  const TABLE = { HARD_LOSS_CEILING_BY_CLASS: 'INDEX_OPT:5000,STOCK_OPT:5000,GOLD:7500,SILVER:7500,MCX:5000' };
  const SHADOW_C = parseFloorBrokerSlConfig({ FLOOR_BROKER_SL_AT: 'ceiling' }, EXIT);
  const LIVE_C = parseFloorBrokerSlConfig({ FLOOR_BROKER_SL: 'live', FLOOR_BROKER_SL_AT: 'ceiling' }, EXIT);
  // NIFTY CE 1 lot 75 @120, LTP 118, the noise floor not armed yet: the ceiling stop rests from entry.
  const nTracker = tracker({ qty: 75 });
  const nState = (over: Partial<FloorState> = {}) => state({ entryPrice: 120, ltp: 118, floor: { basis: 'noise', armed: false, level: 110 }, ...over });

  it('shadow: records ONE placement at the ceiling (53.35, limit 53.20) from entry, unarmed floor or none, and never trails it', async () => {
    const h = harness();
    h.set({ open: [nTracker], board: nState() });
    h.svc.use(EXIT, SHADOW_C, TABLE);
    await h.svc.runOnce(at(0));
    h.set({ board: nState({ ltp: 160, floor: { basis: 'noise', armed: true, level: 150 }, at: T0 + 30_000 }) });
    await h.svc.runOnce(at(30));
    h.set({ board: nState({ ltp: 170, floor: null, at: T0 + 60_000 }) });
    await h.svc.runOnce(at(60));
    expect(h.executor.syncFloorStops).not.toHaveBeenCalled();
    expect(h.actions()).toEqual(['PLACE']);
    expect(h.rows[0]).toMatchObject({ mode: 'shadow', action: 'PLACE', side: 'SELL', triggerPrice: 53.35, limitPrice: 53.2, quantity: 75,
      floorPrice: 110, detail: { at: 'ceiling', ceiling: 5000, entryPrice: 120, valueFactor: 1 } });
  });

  it('GOLD option: the MCX contract value sets the price (1 lot @2000, ₹7,500 → 1925)', async () => {
    const h = harness();
    h.repo.instrument.mockResolvedValue({ tickSize: 50, lotSize: 1 } as never); // ₹0.50 tick
    h.set({ open: [tracker({ symbol: 'GOLD26DEC26130000PE', exchange: 'MCX', qty: 1 })], board: nState({ symbol: 'GOLD26DEC26130000PE', exchange: 'MCX', entryPrice: 2000, ltp: 1990 }) });
    h.svc.use(EXIT, SHADOW_C, TABLE);
    await h.svc.runOnce(at(0));
    expect(h.rows[0]).toMatchObject({ action: 'PLACE', side: 'SELL', triggerPrice: 1925, limitPrice: 1923.5 });
  });

  it('a short mirrors: BUY stop above the entry, rounded down', async () => {
    const h = harness();
    h.set({ open: [tracker({ symbol: 'SENSEX27NOV2683600PE', exchange: 'BFO', qty: -60 })],
      board: nState({ symbol: 'SENSEX27NOV2683600PE', exchange: 'BFO', side: 'SHORT', entryPrice: 200, ltp: 205 }) });
    h.svc.use(EXIT, SHADOW_C, TABLE);
    await h.svc.runOnce(at(0));
    expect(h.rows[0]).toMatchObject({ action: 'PLACE', side: 'BUY', triggerPrice: 283.3, limitPrice: 283.45, quantity: 60 });
  });

  it('trigger through the LTP → SKIP ceiling_through_ltp; table off → SKIP no_ceiling; HOLD → SKIP OWNER_HOLD', async () => {
    const a = harness();
    a.set({ open: [nTracker], board: nState({ ltp: 50 }) });
    a.svc.use(EXIT, SHADOW_C, TABLE);
    await a.svc.runOnce(at(0));
    expect(a.actions()).toEqual(['SKIP:ceiling_through_ltp']);

    const b = harness();
    b.set({ open: [nTracker], board: nState() });
    b.svc.use(EXIT, SHADOW_C, {});
    await b.svc.runOnce(at(0));
    expect(b.actions()).toEqual(['SKIP:no_ceiling']);

    const c = harness();
    c.set({ open: [nTracker], board: nState() });
    c.svc.use(parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_HOLD: 'NIFTY09NOV2624650CE' }), SHADOW_C, TABLE);
    await c.svc.runOnce(at(0));
    expect(c.actions()).toEqual(['SKIP:OWNER_HOLD']);
  });

  it('a manual (not SENTINEL-owned) position gets no ceiling stop', async () => {
    const h = harness();
    h.set({ open: [nTracker], board: nState({ ownership: 'OBSERVE_ONLY' }) });
    h.svc.use(EXIT, SHADOW_C, TABLE);
    await h.svc.runOnce(at(0));
    expect(h.actions()).toEqual(['SKIP:NOT_SENTINEL_OWNED']);
  });

  it('a resting ceiling stop is KEPT (not cancelled) when the price later runs through it — it is the protection', async () => {
    const h = harness();
    h.set({ open: [nTracker], board: nState() });
    h.svc.use(EXIT, SHADOW_C, TABLE);
    await h.svc.runOnce(at(0));
    h.set({ board: nState({ ltp: 50, at: T0 + 30_000 }) });
    await h.svc.runOnce(at(30));
    expect(h.actions()).toEqual(['PLACE']);
  });

  it('on exit: EXIT_COMPARE scores the ceiling stop (would_fill) against the real exit, as today', async () => {
    const h = harness();
    h.set({ open: [nTracker], board: nState() });
    h.svc.use(EXIT, SHADOW_C, TABLE);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await h.svc.runOnce(at(0));
    h.rows[0].at = at(0);
    h.set({ open: [], closed: [tracker({ qty: 75, status: 'CLOSED', exitPrice: 40, exitTime: at(200) })] });
    h.repo.exitFill.mockResolvedValue({ fillPrice: 40, fillAt: at(200) });
    h.candles.read.mockResolvedValue([
      { ts: T0 + 60_000, open: 100, high: 101, low: 60, close: 61, volume: 0 },
      { ts: T0 + 120_000, open: 61, high: 61, low: 45, close: 46, volume: 0 },
    ]);
    for (const s of [210, 400, 415, 430, 445]) await h.svc.runOnce(at(s));
    nowSpy.mockRestore();
    const cmp = h.rows.find((r) => r.action === 'EXIT_COMPARE');
    expect(cmp).toMatchObject({ exitPrice: 40, wouldFillPrice: 53.35, wouldFillLimit: 53.2, reason: 'TRADED_THROUGH' });
    expect(cmp.savedRupees).toBeCloseTo((53.35 - 40) * 75, 2);
  });

  it('live: the intent carries the ceiling trigger (eligible without an armed floor); NOT_PLACEABLE reads ceiling_through_ltp, NO_FLOOR reads no_ceiling', async () => {
    const h = harness();
    h.set({ open: [nTracker], board: nState() });
    h.svc.use(EXIT, LIVE_C, TABLE);
    h.executor.syncFloorStops.mockResolvedValueOnce([{ trackerId: 't1', action: 'NONE', reason: 'NOT_PLACEABLE' }] as never);
    await h.svc.runOnce(at(0));
    const intents = h.executor.syncFloorStops.mock.calls[0][1] as any[];
    expect(intents[0]).toMatchObject({ trackerId: 't1', floor: 53.35, eligible: { ok: true } });
    expect(h.actions()).toEqual(['SKIP:ceiling_through_ltp']);

    const b = harness();
    b.set({ open: [nTracker], board: nState() });
    b.svc.use(EXIT, LIVE_C, {});
    b.executor.syncFloorStops.mockResolvedValueOnce([{ trackerId: 't1', action: 'NONE', reason: 'NO_FLOOR' }] as never);
    await b.svc.runOnce(at(0));
    expect((b.executor.syncFloorStops.mock.calls[0][1] as any[])[0]).toMatchObject({ floor: null });
    expect(b.actions()).toEqual(['SKIP:no_ceiling']);
  });

  it('FLOOR_BROKER_SL_AT unset: the noise placement is unchanged even with the ceiling table on', async () => {
    const h = harness();
    h.svc.use(EXIT, SHADOW, TABLE);
    await h.svc.runOnce(at(0));
    expect(h.rows[0]).toMatchObject({ action: 'PLACE', triggerPrice: 180.75, limitPrice: 180.6, floorPrice: 180.74, detail: null });
    const u = harness();
    u.set({ board: state({ floor: { basis: 'noise', armed: false, level: 175 } }) });
    u.svc.use(EXIT, SHADOW, TABLE);
    await u.svc.runOnce(at(0));
    expect(u.actions()).toEqual(['SKIP:FLOOR_DISARMED']);
  });
});

describe('FloorBrokerSlService — live', () => {
  it('hands the intents to the executor (one call per user) and records what it did', async () => {
    const h = harness();
    h.svc.use(EXIT, LIVE);
    await h.svc.runOnce(at(0));
    expect(h.executor.syncFloorStops).toHaveBeenCalledTimes(1);
    const [user, intents, cfg] = h.executor.syncFloorStops.mock.calls[0] as any[];
    expect(user).toBe('owner');
    expect(intents[0]).toMatchObject({ trackerId: 't1', exchange: 'NFO', token: '40009', tick: 0.05, floor: 180.74, lotSize: 65, eligible: { ok: true } });
    expect(cfg).toMatchObject({ limitTicks: 3, modifyMinSec: 15 });
    expect(h.rows[0]).toMatchObject({ mode: 'live', action: 'PLACE', brokerOrderId: 'SL9', triggerPrice: 180.75 });
  });

  it('a position that closed gets one cancel request (POSITION_CLOSED) for its stop', async () => {
    const h = harness();
    h.svc.use(EXIT, LIVE);
    await h.svc.runOnce(at(0));
    h.set({ open: [], closed: [tracker({ status: 'CLOSED', exitPrice: 180.7, exitTime: at(30) })] });
    h.executor.syncFloorStops.mockResolvedValueOnce([{ trackerId: 't1', action: 'CANCEL', reason: 'POSITION_CLOSED' }] as never);
    await h.svc.runOnce(at(40));
    const intents = h.executor.syncFloorStops.mock.calls[1][1] as any[];
    expect(intents[0]).toMatchObject({ trackerId: 't1', eligible: { ok: false, reason: 'POSITION_CLOSED' } });
    expect(h.actions()).toEqual(['PLACE', 'CANCEL:POSITION_CLOSED']);
  });
});
