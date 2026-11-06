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
