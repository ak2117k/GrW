import { JUDGE_CONCURRENCY, LIVE_RESERVED_SLOTS, SentinelCycleService, type TickReading } from './sentinel-cycle.service';
import type { RosterEntry } from './roster.service';

/**
 * Design 2026-11-22-ai-agents-design.md §4.5: with AI agents on (AI_AGENTS=on + SENTINEL_JUDGE=vertex)
 * the live judgement cap is the registry's `sentinel.judge` concurrency (config: 6); overnight work may
 * use cap − LIVE_RESERVED_SLOTS. Agents off, or on cli: today's 2. Skip-not-queue is unchanged.
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

const ENV_KEYS = ['AI_AGENTS', 'SENTINEL_JUDGE', 'AGENT_SENTINEL_JUDGE_CONCURRENCY', 'AGENT_SENTINEL_JUDGE_AGENT', 'AI_CONFIG_DIR'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** How many of `n` positions wanting a judgement get one on a single tick (the rest are skipped). */
async function liveStarted(n: number) {
  const t = makeSvc();
  t.build.mockResolvedValue(Array.from({ length: n }, (_, i) => entry(`p${i}`)));
  const gate = held();
  t.judge.mockImplementation(() => gate.promise.then(() => HOLD));
  const pass = await t.svc.startForUser('u1', T0);
  await flush();
  const started = t.judge.mock.calls.length;
  const skipped = pass.report.skipped;
  gate.resolve(undefined);
  await pass.settled;
  return { started, skipped };
}

describe('SentinelCycleService judge cap with AI agents', () => {
  it('agents OFF: today\'s cap of 2', async () => {
    process.env.SENTINEL_JUDGE = 'vertex';
    expect(JUDGE_CONCURRENCY).toBe(2);
    await expect(liveStarted(5)).resolves.toEqual({ started: 2, skipped: 3 });
  });

  it('AI_AGENTS=on with SENTINEL_JUDGE=cli: still 2', async () => {
    process.env.AI_AGENTS = 'on';
    process.env.SENTINEL_JUDGE = 'cli';
    await expect(liveStarted(5)).resolves.toEqual({ started: 2, skipped: 3 });
  });

  it('agents ON: the registry\'s sentinel.judge concurrency (config/ai-agents.json: 6); the rest are skipped, not queued', async () => {
    process.env.AI_AGENTS = 'on';
    process.env.SENTINEL_JUDGE = 'vertex';
    await expect(liveStarted(8)).resolves.toEqual({ started: 6, skipped: 2 });
  });

  it('agents ON but sentinel.judge still routed in-process (rollout steps 4-5): cap stays 2', async () => {
    process.env.AI_AGENTS = 'on';
    process.env.SENTINEL_JUDGE = 'vertex';
    process.env.AGENT_SENTINEL_JUDGE_AGENT = 'in-process';
    await expect(liveStarted(5)).resolves.toEqual({ started: 2, skipped: 3 });
  });

  it('agents ON: AGENT_SENTINEL_JUDGE_CONCURRENCY overrides the file', async () => {
    process.env.AI_AGENTS = 'on';
    process.env.SENTINEL_JUDGE = 'vertex';
    process.env.AGENT_SENTINEL_JUDGE_CONCURRENCY = '4';
    await expect(liveStarted(5)).resolves.toEqual({ started: 4, skipped: 1 });
  });

  it('agents ON: overnight reviews may use cap − LIVE_RESERVED_SLOTS at once, keeping the live slot', async () => {
    process.env.AI_AGENTS = 'on';
    process.env.SENTINEL_JUDGE = 'vertex';
    process.env.AGENT_SENTINEL_JUDGE_CONCURRENCY = '4';
    const t = makeSvc();
    const gate = held();
    const started: string[] = [];
    const runs = ['a', 'b', 'c', 'd'].map((id) =>
      t.svc.runShared(id, async () => {
        started.push(id);
        await gate.promise;
      }),
    );
    await flush();
    expect(started).toEqual(['a', 'b', 'c']); // 4 − 1 reserved
    expect(LIVE_RESERVED_SLOTS).toBe(1);

    // The reserved slot is still there for a live judgement.
    t.build.mockResolvedValue([entry('live1')]);
    const pass = await t.svc.startForUser('u1', T0);
    await flush();
    expect(t.judge).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
    await pass.settled;
    await Promise.all(runs);
    expect(started).toEqual(['a', 'b', 'c', 'd']);
  });

  it('agents ON with an unreadable registry: the cap stays 2 (never a crashed sentinel)', async () => {
    process.env.AI_AGENTS = 'on';
    process.env.SENTINEL_JUDGE = 'vertex';
    process.env.AI_CONFIG_DIR = '/definitely/not/a/dir';
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(liveStarted(5)).resolves.toEqual({ started: 2, skipped: 3 });
    } finally {
      err.mockRestore();
    }
  });
});
