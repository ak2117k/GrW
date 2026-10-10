import {
  JUDGE_CONCURRENCY,
  LIVE_RESERVED_SLOTS,
  SentinelCycleService,
  SharedJobExpired,
  type TickReading,
} from './sentinel-cycle.service';
import type { RosterEntry } from './roster.service';

/**
 * The overnight review shares the live judges' concurrency cap and their
 * one-in-flight-per-position rule. Unlike a live judgement it QUEUES for a slot
 * rather than being skipped: a review window that starts while live judges are
 * running waits its turn, it does not lose the night.
 */
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

describe('SentinelCycleService.runShared — overnight judgements share the live cap', () => {
  it('a review queued while the cap is full waits for a slot, then runs', async () => {
    expect(JUDGE_CONCURRENCY).toBe(2);
    const t = makeSvc();
    t.build.mockResolvedValue([entry('a'), entry('b')]);
    const live = [held(), held()];
    t.judge.mockReturnValueOnce(live[0].promise).mockReturnValueOnce(live[1].promise);
    const pass = await t.svc.startForUser('u1', T0);
    await flush();
    expect(t.judge).toHaveBeenCalledTimes(2);

    const review = jest.fn().mockResolvedValue('reviewed');
    const queued = t.svc.runShared('c', review);
    await flush();
    expect(review).not.toHaveBeenCalled();

    // One live slot freeing is not enough: the last free slot is reserved for live work.
    live[0].resolve(HOLD);
    await flush();
    expect(review).not.toHaveBeenCalled();

    live[1].resolve(HOLD);
    await pass.settled;
    await flush();
    expect(review).toHaveBeenCalledTimes(1);
    await expect(queued).resolves.toBe('reviewed');
  });

  it('a review waits while a LIVE judgement is in flight on the same position, even with slots free', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([entry('a')]);
    const live = held();
    t.judge.mockReturnValueOnce(live.promise);
    const pass = await t.svc.startForUser('u1', T0);
    await flush();

    const review = jest.fn().mockResolvedValue(undefined);
    const queued = t.svc.runShared('a', review);
    await flush();
    expect(review).not.toHaveBeenCalled();

    live.resolve(HOLD);
    await pass.settled;
    await queued;
    expect(review).toHaveBeenCalledTimes(1);
  });

  it('a running review occupies a slot and blocks a live judgement on its position', async () => {
    const t = makeSvc();
    const gate = held();
    const running = t.svc.runShared('a', () => gate.promise);
    await flush();

    t.build.mockResolvedValue([entry('a'), entry('b'), entry('c')]);
    const pass = await t.svc.startForUser('u1', T0);
    await flush();
    // 'a' is under review (skipped); one slot is the review's, so only one live judge starts.
    expect(t.judge).toHaveBeenCalledTimes(1);
    expect(pass.report.skipped).toBe(2);

    gate.resolve(undefined);
    await running;
    await pass.settled;
  });

  it('reviews run one at a time, never taking the slot reserved for live work', async () => {
    const t = makeSvc();
    const gates = [held(), held(), held()];
    const started: string[] = [];
    const runs = ['a', 'b', 'c'].map((id, i) =>
      t.svc.runShared(id, async () => {
        started.push(id);
        await gates[i].promise;
      }),
    );
    await flush();
    expect(LIVE_RESERVED_SLOTS).toBe(1);
    expect(started).toEqual(['a']);
    gates[0].resolve(undefined);
    await flush();
    expect(started).toEqual(['a', 'b']);
    gates[1].resolve(undefined);
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    gates[2].resolve(undefined);
    await Promise.all(runs);
  });

  it('under a long overnight queue, a live FIRE still gets a slot on the very next tick', async () => {
    const t = makeSvc();
    const gate = held();
    const queue = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'].map((id) => t.svc.runShared(id, () => gate.promise));
    await flush();

    t.build.mockResolvedValue([entry('live1')]);
    const pass = await t.svc.startForUser('u1', T0);
    await flush();
    expect(pass.pending).toBe(1);
    expect(t.judge).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
    await pass.settled;
    await Promise.all(queue);
  });

  it('a queued job whose venue has opened is dropped without running', async () => {
    const t = makeSvc();
    const gate = held();
    const running = t.svc.runShared('a', () => gate.promise);
    await flush();

    let open = false;
    const work = jest.fn().mockResolvedValue(undefined);
    const queued = t.svc.runShared('b', work, { expired: () => open });
    await flush();
    open = true; // 09:00 — the venue opened while it waited
    gate.resolve(undefined);
    await running;
    await expect(queued).rejects.toBeInstanceOf(SharedJobExpired);
    expect(work).not.toHaveBeenCalled();

    // And the slot is not leaked.
    await expect(t.svc.runShared('c', async () => 'ok')).resolves.toBe('ok');
  });

  it('a job already expired when submitted never runs', async () => {
    const t = makeSvc();
    const work = jest.fn();
    await expect(t.svc.runShared('a', work, { expired: () => true })).rejects.toBeInstanceOf(SharedJobExpired);
    expect(work).not.toHaveBeenCalled();
  });

  it('a review that throws frees its slot and rejects to its caller', async () => {
    const t = makeSvc();
    await expect(t.svc.runShared('a', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const after = jest.fn().mockResolvedValue(1);
    await expect(t.svc.runShared('a', after)).resolves.toBe(1);
  });
});

describe('SentinelCycleService — an overnight verdict is not the live "last look"', () => {
  it('reads its last verdict live-only, so a 08:50 pre-open row cannot delay the opening heartbeat', async () => {
    const recentForTracker = jest.fn().mockResolvedValue([]);
    const svc = new SentinelCycleService(
      { build: jest.fn().mockResolvedValue([entry('a')]) } as never,
      { evaluate: jest.fn().mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null }) } as never,
      { build: jest.fn() } as never,
      { ensureFor: jest.fn() } as never,
      { judge: jest.fn(), promptVersion: 'v2/t1' } as never,
      { record: jest.fn(), recentForTracker } as never,
      { captureAndCompare: jest.fn().mockResolvedValue({ now: null, prev: null }) } as never,
      { tickFor: jest.fn().mockResolvedValue(tick) } as never,
    );
    await svc.runForUser('u1', T0);
    expect(recentForTracker).toHaveBeenCalledWith('a', 1, { liveOnly: true });
  });
});
