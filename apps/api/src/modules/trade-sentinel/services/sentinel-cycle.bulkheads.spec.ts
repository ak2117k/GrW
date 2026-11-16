import {
  JUDGE_JOB_TIMEOUT_MS,
  SENSOR_PASS_TIMEOUT_MS,
  SHARED_JOB_TIMEOUT_MS,
  SentinelCycleService,
  SharedJobTimeout,
  type TickReading,
} from './sentinel-cycle.service';
import type { RosterEntry } from './roster.service';

/** 2026-11-16 incident: bulkheads (signal lane) and hard time limits. */
const HOLD = {
  verdict: 'HOLD',
  confidence: 'high',
  thesisStatus: 'INTACT',
  recoveryAvailable: true,
  reason: 'ok',
  evidence: ['money.netPnl'],
  invalidationPoint: 'x',
  reviewIn: 300,
};

function held<T = unknown>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const entry = (id: string): RosterEntry => ({
  userId: 'u1',
  trackerId: id,
  symbol: id.toUpperCase(),
  exchange: 'NFO',
  kind: 'POSITION',
  ownership: 'SENTINEL',
  watched: true,
  reason: 'unowned position — sentinel claims it',
});

const tick: TickReading = {
  segment: 'OPT',
  side: 'LONG',
  entryPrice: 100,
  qty: 10,
  ltp: 100,
  underlyingLtp: 100,
  underlyingLtpAt: null,
  underlyingLtpSource: 'x',
  underlyingLtpReason: null,
  structureSymbol: 'NIFTY',
  nearestSupport: null,
  nearestResistance: null,
  structureReason: null,
  structureAt: null,
  structureSource: 'x',
  holdingHigh: null,
  holdingLow: null,
  entryTime: new Date('2026-10-12T04:00:00.000Z'),
  expiry: null,
  volumeRatio: null,
  freshNewsCount: null,
  factorValues: {},
  factorsReason: null,
};

function makeSvc() {
  const build = jest.fn().mockResolvedValue([]);
  const judge = jest.fn().mockResolvedValue(HOLD);
  const svc = new SentinelCycleService(
    { build } as never,
    { evaluate: jest.fn().mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'FIRE' }) } as never,
    { build: jest.fn().mockResolvedValue({ position: {}, money: { netPnl: 0, greenFloorPrice: null } }) } as never,
    { ensureFor: jest.fn().mockResolvedValue({ direction: 'LONG', reason: 'r', levelPrice: null, targetPrice: null, invalidation: null, source: 'INFERRED' }) } as never,
    { judge, promptVersion: 'v2/t1' } as never,
    { record: jest.fn().mockResolvedValue({}), recentForTracker: jest.fn().mockResolvedValue([]) } as never,
    { captureAndCompare: jest.fn().mockResolvedValue({ now: null, prev: null }) } as never,
    { tickFor: jest.fn().mockResolvedValue(tick) } as never,
  );
  return { svc, build, judge };
}

const T0 = new Date('2026-10-12T09:00:00.000Z');


describe('bulkheads: the signal lane', () => {
  it('a signal job runs while BOTH exit slots are busy, and a second signal job queues behind it', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([entry('a'), entry('b')]);
    const live = [held(), held()];
    t.judge.mockReturnValueOnce(live[0].promise).mockReturnValueOnce(live[1].promise);
    const pass = await t.svc.startForUser('u1', T0);
    await flush();
    expect(t.judge).toHaveBeenCalledTimes(2);

    const first = held<string>();
    const sig1 = t.svc.runShared('sig:1', () => first.promise, { lane: 'signals' });
    const second = jest.fn().mockResolvedValue('two');
    const sig2 = t.svc.runShared('sig:2', second, { lane: 'signals' });
    await flush();
    expect(second).not.toHaveBeenCalled();
    first.resolve('one');
    await expect(sig1).resolves.toBe('one');
    await expect(sig2).resolves.toBe('two');

    // A background (non-lane) job still waits for the exit slots.
    const bg = jest.fn().mockResolvedValue('bg');
    const queued = t.svc.runShared('bg', bg);
    await flush();
    expect(bg).not.toHaveBeenCalled();
    live[0].resolve(HOLD);
    live[1].resolve(HOLD);
    await pass.settled;
    await expect(queued).resolves.toBe('bg');
  });
});

describe('hard time limits', () => {
  afterEach(() => jest.useRealTimers());

  it('a shared job that never answers is cut at SHARED_JOB_TIMEOUT_MS and its slot is freed', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const t = makeSvc();
    const stuck = t.svc.runShared('x', () => new Promise<never>(() => undefined));
    const caught = stuck.catch((e) => e);
    await flush();
    jest.advanceTimersByTime(SHARED_JOB_TIMEOUT_MS + 1);
    expect(await caught).toBeInstanceOf(SharedJobTimeout);
    const next = jest.fn().mockResolvedValue('ok');
    await expect(t.svc.runShared('y', next)).resolves.toBe('ok');
  });

  it('a live judgement that never settles frees its slot after JUDGE_JOB_TIMEOUT_MS', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const t = makeSvc();
    t.build.mockResolvedValue([entry('a'), entry('b')]);
    t.judge.mockReturnValue(new Promise(() => undefined));
    await t.svc.startForUser('u1', T0);
    await flush();
    const bgWork = jest.fn().mockResolvedValue('bg');
    const bg = t.svc.runShared('c', bgWork);
    await flush();
    expect(bgWork).not.toHaveBeenCalled();
    jest.advanceTimersByTime(JUDGE_JOB_TIMEOUT_MS + 1);
    await flush();
    await expect(bg).resolves.toBe('bg');
  });

  it('a position whose sensor pass hangs does not stall the cycle: the pass moves on, the next one skips it', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const t = makeSvc();
    t.build.mockResolvedValue([entry('a'), entry('b')]);
    const ticks = (t.svc as unknown as { ticks: { tickFor: jest.Mock } }).ticks;
    ticks.tickFor.mockImplementation((id: string) => (id === 'a' ? new Promise(() => undefined) : Promise.resolve(tick)));
    const p1 = t.svc.startForUser('u1', T0);
    await flush();
    jest.advanceTimersByTime(SENSOR_PASS_TIMEOUT_MS + 1);
    const r1 = await p1;
    expect(r1.report.failed).toBe(1);
    await flush();
    expect(t.judge).toHaveBeenCalledTimes(1); // b was still judged
    const r2 = await t.svc.startForUser('u1', new Date(T0.getTime() + 30_000));
    expect(r2.report.failed).toBe(1); // a skipped, not started twice
    expect(ticks.tickFor.mock.calls.filter((c) => c[0] === 'a')).toHaveLength(1);
  });
});

describe('fast hard-loss guard (a stuck position still gets its ₹ loss check)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.HARD_LOSS_EXIT_RUPEES = '2000';
    process.env.HARD_LOSS_CAP_RUPEES = '3000';
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...saved };
  });

  async function stuckAt(ltp: number, id = 'a') {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const t = makeSvc();
    t.build.mockResolvedValue([{ ...entry(id), symbol: 'NIFTY23NOV2624000CE' }]);
    const ticks = (t.svc as unknown as { ticks: { tickFor: jest.Mock; quickPrice?: jest.Mock } }).ticks;
    ticks.tickFor.mockImplementation(() => new Promise(() => undefined));
    ticks.quickPrice = jest.fn().mockResolvedValue({ segment: 'OPT', side: 'LONG', entryPrice: 100, qty: 750, ltp, source: 'hub' });
    const record = (t.svc as unknown as { verdicts: { record: jest.Mock } }).verdicts.record;
    for (let i = 0; i < 4; i++) {
      const p = t.svc.startForUser('u1', new Date(T0.getTime() + i * 30_000));
      await flush();
      jest.advanceTimersByTime(SENSOR_PASS_TIMEOUT_MS + 1);
      await p;
      await flush();
      jest.advanceTimersByTime(30_000);
      await flush();
    }
    return { record, quick: ticks.quickPrice };
  }

  it('a real position past the ₹ loss limit is exited by rule even though its full look is stuck', async () => {
    const { record, quick } = await stuckAt(80); // −₹15,000 gross on 750 qty
    expect(quick).toHaveBeenCalled();
    const exits = record.mock.calls.map((c) => c[0]).filter((v) => v.verdict === 'EXIT_NOW');
    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toMatch(/fast guard/);
    expect(exits[0].promptVersion).toBe('rule:floor-hard/1');
  });

  it('a position in profit is never exited by the fast guard', async () => {
    const { record } = await stuckAt(120);
    expect(record.mock.calls.filter((c) => c[0].verdict === 'EXIT_NOW')).toHaveLength(0);
  });

  it('paper positions are never touched by the fast guard', async () => {
    const { record, quick } = await stuckAt(80, 'paper:x');
    expect(quick).not.toHaveBeenCalled();
    expect(record.mock.calls.filter((c) => c[0].verdict === 'EXIT_NOW')).toHaveLength(0);
  });
});
