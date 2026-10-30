// apps/api/src/modules/sentinel-executor/services/trigger-watch.service.spec.ts
import type { Price, PriceResult } from '../../market-hub/hub.types';
import { TriggerWatchService } from './trigger-watch.service';

const ENV = {
  SENTINEL_TRIGGERS_ENABLED: 'true', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_QTY_UNITS: 'MCX:units',
};
const T0 = new Date('2026-10-13T17:00:00Z');
const ms = (d: Date, plus: number) => new Date(d.getTime() + plus);
const STORED = {
  v: 1, instrument: 'UNDERLYING', op: 'BELOW', price: 8930,
  watch: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' }, seen: { price: 8951, at: T0.toISOString() },
};
const TRACKER = { id: 't1', userId: 'owner', symbol: 'CRUDEOIL19NOV268950CE', exchange: 'MCX', token: '5001', qty: 100, status: 'OPEN', kind: 'POSITION' };
const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'v1', userId: 'owner', trackerId: 't1', symbol: TRACKER.symbol, verdict: 'EXIT_ARMED', exitTrigger: STORED, createdAt: T0, ...over,
});
const fresh = (ltp: number, at = T0.getTime()): PriceResult => ({
  kind: 'fresh', price: { ref: { exchange: 'MCX', token: '472789', symbol: 'F' }, ltp, at, source: 'ws' },
});

function harness(o: {
  proposals?: unknown[][]; tracker?: unknown; price?: PriceResult; hub?: boolean;
  claimFire?: () => Promise<boolean>; armed?: unknown[]; closed?: string[];
} = {}) {
  const listeners: Array<(p: Price) => void> = [];
  const hub = {
    price: jest.fn(() => o.price ?? fresh(8951)),
    prices: jest.fn(),
    watch: jest.fn(async () => undefined),
    unwatch: jest.fn(async () => undefined),
    onPrice: jest.fn((fn: (p: Price) => void) => { listeners.push(fn); return () => undefined; }),
  };
  const source = { hubFor: jest.fn(() => (o.hub === false ? null : hub)), record: jest.fn() };
  const moduleRef = { get: jest.fn(() => source) };
  const batches = [...(o.proposals ?? [[]])];
  const repo = {
    pendingProposals: jest.fn(async () => (batches.length > 1 ? batches.shift() : batches[0]) ?? []),
    trackerFor: jest.fn(async (..._a: any[]) => (o.tracker === undefined ? TRACKER : o.tracker)),
    reject: jest.fn(async (..._a: any[]) => true),
    arm: jest.fn(async (..._a: any[]) => ({ id: 'trg1', superseded: [] as string[] })),
    claimFire: jest.fn(o.claimFire ?? (async (..._a: any[]) => true)),
    expire: jest.fn(async (ids: string[], ..._a: any[]) => ids.length),
    loadArmed: jest.fn(async () => o.armed ?? []),
    trackerExchanges: jest.fn(async () => new Map([['t1', 'MCX']])),
    closedTrackerIds: jest.fn(async (..._a: any[]) => o.closed ?? ([] as string[])),
  };
  const execRepo = { claim: jest.fn(async (..._a: any[]) => 'exec1'), findByVerdictId: jest.fn(async (..._a: any[]) => ({ fillPrice: 8920, orderLtp: 8924, decisionLtp: 8924 })) };
  const executor = { execute: jest.fn(async (..._a: any[]) => ({ status: 'DRY_RUN' })) };
  const clock = { isOpen: jest.fn(() => true) };
  const svc = new TriggerWatchService(repo as never, execRepo as never, executor as never, moduleRef as never, clock as never);
  const emit = (ltp: number, at: Date, source: Price['source'] = 'ws') => {
    jest.spyOn(Date, 'now').mockReturnValue(at.getTime());
    for (const fn of listeners) fn({ ref: { exchange: 'MCX', token: '472789', symbol: 'F' }, ltp, at: at.getTime(), source });
  };
  return { svc, hub, source, moduleRef, repo, execRepo, executor, clock, emit, listeners };
}

let intervalSpy: jest.SpyInstance;
beforeEach(() => {
  intervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue({ unref: () => undefined } as never);
});
afterEach(() => jest.restoreAllMocks());

/** Start, then one pass that arms proposal v1 at T0. */
async function armed(h: ReturnType<typeof harness>) {
  expect(h.svc.start(ENV)).toBe(true);
  await h.svc.pass(T0);
  expect(h.repo.arm).toHaveBeenCalledTimes(1);
}

describe('TriggerWatchService — arming', () => {
  it('arms a valid UNDERLYING proposal and watches the MCX future at priority 1', async () => {
    const h = harness({ proposals: [[proposal()]] });
    await armed(h);
    expect(h.hub.watch).toHaveBeenCalledWith([{ exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' }], 1, 'sentinel-triggers');
    expect(h.repo.arm.mock.calls[0][1]).toEqual({
      instrument: 'UNDERLYING', op: 'BELOW', price: 8930, watchExchange: 'MCX', watchToken: '472789',
      watchSymbol: 'CRUDEOIL19NOV26FUT', refPrice: 8951,
    });
  });

  it('PREMIUM watches the tracker contract and adds no hub watch', async () => {
    const h = harness({
      proposals: [[proposal({ exitTrigger: { v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 180, watch: null } })]],
      price: { kind: 'fresh', price: { ref: { exchange: 'MCX', token: '5001', symbol: 'C' }, ltp: 212, at: T0.getTime(), source: 'ws' } },
    });
    await armed(h);
    expect(h.hub.watch).not.toHaveBeenCalled();
    expect(h.repo.arm.mock.calls[0][1]).toMatchObject({ watchExchange: 'MCX', watchToken: '5001', watchSymbol: TRACKER.symbol });
  });

  it.each([
    ['malformed', { exitTrigger: { v: 1, problem: 'price is not a positive number' } }, undefined, /^MALFORMED: price/],
    ['not protective (long CE, UNDERLYING ABOVE)', { exitTrigger: { ...STORED, op: 'ABOVE', price: 8970 } }, undefined, /^NOT_PROTECTIVE$/],
    ['tracker closed', {}, { ...TRACKER, status: 'CLOSED' }, /^TRACKER_NOT_OPEN$/],
    ['cash equity', {}, { ...TRACKER, exchange: 'NSE' }, /^EXCHANGE_NOT_FNO$/],
    ['no watch target', { exitTrigger: { ...STORED, watch: null } }, undefined, /^NO_WATCH_TARGET$/],
  ])('rejects %s, recorded, never armed', async (_l, over, tracker, reason) => {
    const h = harness({ proposals: [[proposal(over as never)]], tracker });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.repo.arm).not.toHaveBeenCalled();
    expect(h.repo.reject.mock.calls[0][2]).toMatch(reason);
  });

  it('no hub for the user → REJECTED: NO_HUB', async () => {
    const h = harness({ proposals: [[proposal()]], hub: false });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.repo.reject.mock.calls[0][2]).toBe('NO_HUB');
  });

  it('slot exhaustion: an unpriced instrument is deferred, then REJECTED NO_FRESH_PRICE after 30 s and its watch released', async () => {
    const h = harness({ proposals: [[proposal()]], price: { kind: 'unavailable', reason: 'never-priced' } });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.repo.reject).not.toHaveBeenCalled();
    expect(h.hub.watch).toHaveBeenCalledTimes(1);
    await h.svc.pass(ms(T0, 10_000));
    expect(h.repo.reject).not.toHaveBeenCalled();
    expect(h.hub.watch).toHaveBeenCalledTimes(1);           // not re-registered every pass
    await h.svc.pass(ms(T0, 31_000));
    expect(h.repo.reject.mock.calls[0][2]).toMatch(/^NO_FRESH_PRICE/);
    expect(h.hub.unwatch).toHaveBeenCalledWith([{ exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' }], 'sentinel-triggers');
  });

  it('market closed at arming → REJECTED: EXCHANGE_CLOSED', async () => {
    const h = harness({
      proposals: [[proposal()]],
      price: { kind: 'market-closed', price: { ref: { exchange: 'MCX', token: '472789', symbol: 'F' }, ltp: 8951, at: T0.getTime(), source: 'ws' } },
    });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.repo.reject.mock.calls[0][2]).toBe('EXCHANGE_CLOSED');
  });

  it('tighten-only: a looser later proposal is REJECTED and the armed level still fires', async () => {
    const h = harness({ proposals: [[proposal()], [proposal({ id: 'v2', exitTrigger: { ...STORED, price: 8900 } })], []] });
    await armed(h);
    await h.svc.pass(ms(T0, 5000));
    expect(h.repo.reject.mock.calls[0][2]).toBe('LOOSENS');
    h.emit(8925, ms(T0, 6000));
    h.emit(8924, ms(T0, 7100));
    await new Promise((r) => setImmediate(r));
    expect(h.repo.claimFire).toHaveBeenCalledWith('trg1', expect.objectContaining({ price: 8924 }), expect.any(Date));
  });
});

describe('TriggerWatchService — firing', () => {
  it('fires ONCE under concurrent ticks while the claim is in flight (R7)', async () => {
    let release!: (v: boolean) => void;
    const h = harness({ proposals: [[proposal()], []], claimFire: () => new Promise<boolean>((r) => { release = r; }) });
    await armed(h);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));   // fires
    h.emit(8920, ms(T0, 2200));   // concurrent
    h.emit(8919, ms(T0, 3400));   // concurrent
    expect(h.repo.claimFire).toHaveBeenCalledTimes(1);
    release(true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(h.execRepo.claim).toHaveBeenCalledTimes(1);
    expect(h.execRepo.claim.mock.calls[0][0]).toMatchObject({ id: 'trg_trg1', userId: 'owner', trackerId: 't1' });
    expect(h.execRepo.claim.mock.calls[0][1]).toBe('dry-run');
    expect(h.executor.execute).toHaveBeenCalledTimes(1);
    expect(h.executor.execute.mock.calls[0][0]).toBe('exec1');
    expect(h.executor.execute.mock.calls[0][4]).toBe('PRICE_TRIGGER');
    expect(h.executor.execute.mock.calls[0][1].reason).toMatch(/^PRICE_TRIGGER: CRUDEOIL19NOV26FUT < 8930 — fired at 8924 \(2 ticks over 1100 ms\)/);
  });

  it('a lost claim (another process fired, or it expired) executes nothing', async () => {
    const h = harness({ proposals: [[proposal()], []], claimFire: async () => false });
    await armed(h);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));
    await new Promise((r) => setImmediate(r));
    expect(h.execRepo.claim).not.toHaveBeenCalled();
    expect(h.executor.execute).not.toHaveBeenCalled();
  });

  it('a claim that THROWS re-arms in memory and sends nothing (R8); a later cross retries', async () => {
    const claimFire = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(true);
    const h = harness({ proposals: [[proposal()], []], claimFire });
    await armed(h);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));
    await new Promise((r) => setImmediate(r));
    expect(h.executor.execute).not.toHaveBeenCalled();
    h.emit(8923, ms(T0, 3000));
    h.emit(8922, ms(T0, 4100));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(claimFire).toHaveBeenCalledTimes(2);
    expect(h.executor.execute).toHaveBeenCalledTimes(1);
  });

  it('a claim that THROWS never re-arms over a newer trigger armed for the tracker meanwhile', async () => {
    let fail!: (e: Error) => void;
    const claimFire = jest.fn()
      .mockImplementationOnce(() => new Promise<boolean>((_r, j) => { fail = j; }))
      .mockResolvedValue(true);
    const h = harness({ proposals: [[proposal()], [proposal({ id: 'v2', exitTrigger: { ...STORED, price: 8935 } })], []], claimFire });
    await armed(h);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));   // trg1 fires; its claim hangs
    h.repo.arm.mockResolvedValueOnce({ id: 'trg2', superseded: ['trg1'] });
    await h.svc.pass(ms(T0, 5000)); // v2 arms trg2 at 8935
    fail(new Error('db down'));
    await new Promise((r) => setImmediate(r));
    h.emit(8933, ms(T0, 6000));
    h.emit(8932, ms(T0, 7100));   // beyond 8935, not beyond 8930: only trg2 can fire
    expect(claimFire).toHaveBeenLastCalledWith('trg2', expect.objectContaining({ price: 8932 }), expect.any(Date));
    expect(h.executor.execute).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'trg_trg1' }), expect.anything(), expect.anything(), expect.anything());
  });

  it('a claim that THROWS after a newer trigger moved to another instrument releases the old watch', async () => {
    let fail!: (e: Error) => void;
    const claimFire = jest.fn().mockImplementationOnce(() => new Promise<boolean>((_r, j) => { fail = j; }));
    const other = { exchange: 'MCX', token: '472790', symbol: 'CRUDEOIL18DEC26FUT' };
    const h = harness({
      proposals: [[proposal()], [proposal({ id: 'v2', exitTrigger: { ...STORED, price: 8935, watch: other } })], []],
      claimFire, closed: [],
    });
    await armed(h);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));   // trg1 fires; its claim hangs
    h.repo.arm.mockResolvedValueOnce({ id: 'trg2', superseded: ['trg1'] });
    await h.svc.pass(ms(T0, 5000)); // v2 arms trg2 on the other future
    expect(h.repo.arm).toHaveBeenCalledTimes(2);
    fail(new Error('db down'));
    await new Promise((r) => setImmediate(r));
    expect(h.hub.unwatch).toHaveBeenCalledWith([{ exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' }], 'sentinel-triggers');
    expect(h.hub.unwatch).not.toHaveBeenCalledWith([other], 'sentinel-triggers');
  });

  it('one bad print never sells', async () => {
    const h = harness({ proposals: [[proposal()], []] });
    await armed(h);
    h.emit(8000, ms(T0, 1000));
    h.emit(8950, ms(T0, 2100));
    expect(h.repo.claimFire).not.toHaveBeenCalled();
  });

  it('ticks while the exchange is closed never fire', async () => {
    const h = harness({ proposals: [[proposal()], []] });
    await armed(h);
    h.clock.isOpen.mockReturnValue(false);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));
    expect(h.repo.claimFire).not.toHaveBeenCalled();
  });
});

describe('TriggerWatchService — expiry and rebuild', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'trg9', userId: 'owner', trackerId: 't1', verdictId: 'v9', symbol: TRACKER.symbol, instrument: 'UNDERLYING', op: 'BELOW',
    price: 8930, watchExchange: 'MCX', watchToken: '472789', watchSymbol: 'CRUDEOIL19NOV26FUT', status: 'ARMED',
    armedAt: ms(T0, -60_000), ...over,
  });

  it('boot rebuilds ARMED rows into memory and watches their underlyings; they fire', async () => {
    const h = harness({ armed: [row()] });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.hub.watch).toHaveBeenCalledWith([{ exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' }], 1, 'sentinel-triggers');
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));
    expect(h.repo.claimFire).toHaveBeenCalledWith('trg9', expect.anything(), expect.any(Date));
  });

  it('a hub that appears only AFTER the boot rebuild still gets the rebuilt underlyings watched', async () => {
    const h = harness({ armed: [row()] });
    h.source.hubFor.mockReturnValue(null as never);
    h.svc.start(ENV);
    await h.svc.pass(T0);               // boot: no hub yet — the trigger is in memory, unwatched
    expect(h.hub.watch).not.toHaveBeenCalled();
    h.source.hubFor.mockReturnValue(h.hub as never);
    await h.svc.pass(ms(T0, 5000));     // the hub is up now
    expect(h.hub.watch).toHaveBeenCalledWith([{ exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' }], 1, 'sentinel-triggers');
    h.emit(8925, ms(T0, 6000));
    h.emit(8924, ms(T0, 7100));
    expect(h.repo.claimFire).toHaveBeenCalledWith('trg9', expect.anything(), expect.any(Date));
  });

  it('boot expires rows past max age, and rows whose exchange is closed', async () => {
    const h = harness({ armed: [row({ armedAt: ms(T0, -241 * 60_000) })] });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.repo.expire).toHaveBeenCalledWith(['trg9'], 'MAX_AGE', T0);

    const c = harness({ armed: [row()] });
    c.clock.isOpen.mockReturnValue(false);
    c.svc.start(ENV);
    await c.svc.pass(T0);
    expect(c.repo.expire).toHaveBeenCalledWith(['trg9'], 'EXCHANGE_CLOSED', T0);
  });

  it('maintenance (every 30 s) expires triggers whose tracker closed, and they no longer fire', async () => {
    const h = harness({ proposals: [[proposal()], []] });
    await armed(h);
    h.repo.closedTrackerIds.mockResolvedValue(['t1']);
    await h.svc.pass(ms(T0, 31_000));
    expect(h.repo.expire).toHaveBeenCalledWith(['trg1'], 'TRACKER_CLOSED', ms(T0, 31_000));
    h.emit(8925, ms(T0, 32_000));
    h.emit(8924, ms(T0, 33_100));
    expect(h.repo.claimFire).not.toHaveBeenCalled();
    expect(h.hub.unwatch).toHaveBeenCalled();
  });
});

describe('TriggerWatchService — disabled is inert (R11, Review Focus 6)', () => {
  it.each([
    ['flag unset', {}],
    ['flag not exactly true', { ...ENV, SENTINEL_TRIGGERS_ENABLED: 'TRUE' }],
    ['auto-exit off', { ...ENV, AI_AUTO_EXIT_ENABLED: 'false' }],
    ['no allow-listed user', { ...ENV, AI_AUTO_EXIT_USER_IDS: '' }],
  ])('%s: no timer, no hub lookup, no query, no listener', async (_l, env) => {
    const h = harness({ proposals: [[proposal()]] });
    expect(h.svc.start(env)).toBe(false);
    await h.svc.pass(T0);
    h.svc.onPrice({ ref: { exchange: 'MCX', token: '472789', symbol: 'F' }, ltp: 1, at: T0.getTime(), source: 'ws' });
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(h.moduleRef.get).not.toHaveBeenCalled();
    expect(h.hub.onPrice).not.toHaveBeenCalled();
    expect(h.hub.watch).not.toHaveBeenCalled();
    for (const fn of Object.values(h.repo)) expect(fn).not.toHaveBeenCalled();
  });

  it('BOOT_JOBS=false: inert even when everything is enabled', async () => {
    const prev = process.env.BOOT_JOBS;
    process.env.BOOT_JOBS = 'false';
    try {
      const h = harness();
      expect(h.svc.start(ENV)).toBe(false);
      expect(intervalSpy).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.BOOT_JOBS; else process.env.BOOT_JOBS = prev;
    }
  });
});

describe('TriggerWatchService — exit noise read (record only)', () => {
  it('a fired trigger the executor acted on is read after the attempt, never awaited; a hanging read changes nothing', async () => {
    const h = harness({ proposals: [[proposal()], []] });
    const record = jest.fn(() => new Promise(() => undefined));
    (h.svc as unknown as { noise: unknown }).noise = { record };
    await armed(h);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(h.executor.execute).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect((record.mock.calls[0] as unknown[])[0]).toMatchObject({
      source: 'real', refId: 'trg_trg1', exitRule: 'AI_TRIGGER', trackerId: 't1', userId: 'owner', exitPrice: 8920,
      context: { execution: 'DRY_RUN', trigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930, armedBy: 'v1' } },
    });
  });
});
