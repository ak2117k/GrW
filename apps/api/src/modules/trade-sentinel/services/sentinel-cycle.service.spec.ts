import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { Logger } from '@nestjs/common';
import {
  AGENT_RETRY_BASE_MS,
  AGENT_RETRY_MAX_MS,
  OI_CAPTURE_INTERVAL_MS,
  SentinelCycleService,
  THESIS_RETRY_COOLDOWN_MS,
  TICK_SOURCE,
  agentBackoffMs,
  previousFactorValues,
  storedFloorArmed,
  suppressRepeatWallShift,
  wallKey,
  withCashUnderlying,
  type TickReading,
} from './sentinel-cycle.service';
import type { RosterEntry } from './roster.service';
import type { StoredThesis } from './context-packet.service';
import { HEARTBEAT_INTERVAL_MS, type TripwireResult } from './tripwire.service';

const USER = 'u1';

const watched = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: USER,
  trackerId: id,
  symbol: id.toUpperCase(),
  // NSE keeps the 15:30 session these assertions were written against; an MCX
  // fixture would change what `session.minutesToClose` reports.
  exchange: 'NSE',
  kind: 'POSITION',
  ownership: 'SENTINEL',
  watched: true,
  reason: 'unowned position — sentinel claims it',
  ...over,
});

const tick = (over: Partial<TickReading> = {}): TickReading => ({
  segment: 'EQ_INTRADAY',
  side: 'LONG',
  entryPrice: 100,
  qty: 10,
  ltp: 100,
  underlyingLtp: 100,
  underlyingLtpAt: null,
  underlyingLtpSource: 'market-data (underlying spot — live feed tick)',
  underlyingLtpReason: null,
  structureSymbol: 'T1',
  nearestSupport: null,
  nearestResistance: null,
  structureReason: null,
  structureAt: null,
  structureSource: 'signal-generator.analyze (15m level book)',
  holdingHigh: null,
  holdingLow: null,
  entryTime: new Date('2026-08-14T04:00:00.000Z'),
  expiry: null,
  volumeRatio: null,
  freshNewsCount: null,
  factorValues: {},
  factorsReason: null,
  // No OI fields: the cycle captures walls on its own cadence and owns their
  // provenance, so `TickReading` excludes them.
  ...over,
});

const inferredThesis = (over: Partial<StoredThesis> = {}): StoredThesis => ({
  direction: 'LONG',
  reason: 'bought the retest of the 100 shelf',
  levelPrice: 100,
  targetPrice: 120,
  invalidation: 95,
  source: 'INFERRED',
  ...over,
});

/** The honest-unknown placeholder, exactly as ThesisService writes it. */
const placeholderThesis = (): StoredThesis =>
  inferredThesis({
    reason:
      'thesis could not be inferred — could not reach the Anthropic API. The intent behind ' +
      'this LONG position is UNKNOWN; do not read it as a confirmed setup or judge it against one.',
    levelPrice: null,
    targetPrice: null,
    invalidation: null,
  });

const verdictRow = (over: Record<string, unknown> = {}) => ({
  createdAt: new Date('2026-08-14T05:00:00.000Z'),
  packet: { money: { greenFloorArmed: false }, macro: { realFactors: { available: false } } },
  verdict: 'HOLD',
  reason: 'ok',
  ...over,
});

function makeSvc() {
  const build = jest.fn().mockResolvedValue([]);
  const evaluate = jest.fn().mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'FIRE' as const });
  const buildPacket = jest.fn();
  const ensureFor = jest.fn().mockResolvedValue(inferredThesis());
  const judge = jest.fn();
  const record = jest.fn().mockResolvedValue({});
  const recentForTracker = jest.fn().mockResolvedValue([]);
  const captureAndCompare = jest.fn().mockResolvedValue({ now: null, prev: null });
  const tickFor = jest.fn().mockResolvedValue(tick());

  buildPacket.mockImplementation((_entry, t) =>
    Promise.resolve({
      position: {},
      money: {
        netPnl: 42,
        greenFloorPrice: 101.5,
        // Mirrors the real packet: the latch wins over the per-tick reading.
        greenFloorArmed: t.greenFloorArmedLatched,
      },
    }),
  );
  judge.mockResolvedValue({
    verdict: 'HOLD',
    confidence: 'high',
    thesisStatus: 'INTACT',
    recoveryAvailable: true,
    reason: 'ok',
    evidence: ['money.netPnl'],
    invalidationPoint: 'x',
    reviewIn: 300,
  });

  const svc = new SentinelCycleService(
    { build } as never,
    { evaluate } as never,
    { build: buildPacket } as never,
    { ensureFor } as never,
    { judge, promptVersion: 'sentinel-v3' } as never,
    { record, recentForTracker } as never,
    { captureAndCompare } as never,
    { tickFor } as never,
  );

  return {
    svc,
    build,
    evaluate,
    buildPacket,
    ensureFor,
    judge,
    record,
    recentForTracker,
    captureAndCompare,
    tickFor,
  };
}

/** The TripwireInput the cycle handed the sensors on the nth position. */
const tripwireInput = (evaluate: jest.Mock, n = 0) => evaluate.mock.calls[n][0];

describe('SentinelCycleService — roster gating', () => {
  it('never evaluates an unwatched entry, and does no work for it at all', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1', { watched: false, reason: 'over capacity' })]);

    const report = await t.svc.runForUser(USER);

    expect(t.judge).not.toHaveBeenCalled();
    // An unwatched entry must not even cost a tick fetch or an OI snapshot write:
    // the cap exists to bound work, not merely to bound verdicts.
    expect(t.tickFor).not.toHaveBeenCalled();
    expect(t.captureAndCompare).not.toHaveBeenCalled();
    expect(report).toEqual({ evaluated: 0, skipped: 0, failed: 0, unwatched: 1 });
  });

  it('skips a watched entry when no sensor fired and no heartbeat is due', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.evaluate.mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null });

    const report = await t.svc.runForUser(USER);

    expect(t.judge).not.toHaveBeenCalled();
    expect(t.ensureFor).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
    expect(report).toEqual({ evaluated: 0, skipped: 1, failed: 0, unwatched: 0 });
  });

  it('still captures the OI walls on a skipped tick — the series is independent of the verdict', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000 }));
    t.evaluate.mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null });

    await t.svc.runForUser(USER);

    expect(t.captureAndCompare).toHaveBeenCalledTimes(1);
  });

  it('reports an empty roster as an empty cycle rather than throwing', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([]);

    await expect(t.svc.runForUser(USER)).resolves.toEqual({
      evaluated: 0,
      skipped: 0,
      failed: 0,
      unwatched: 0,
    });
    expect(t.tickFor).not.toHaveBeenCalled();
  });

  it('evaluates an OBSERVE_ONLY position, and makes the verdict attributable to it', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([
      watched('t1', { kind: 'HOLDING', ownership: 'OBSERVE_ONLY', reason: 'holding — observed, never closed' }),
    ]);

    const report = await t.svc.runForUser(USER);

    // Deliberate: Stage 0 measures judgement quality, and dropping the verdicts
    // on every holding would measure it on a biased sample.
    expect(report.evaluated).toBe(1);
    expect(t.record).toHaveBeenCalledTimes(1);
    // But it must be separable afterwards — Task 13 scores these apart, and a
    // Stage 1 executor must key off ownership rather than off `watched`.
    expect(t.buildPacket.mock.calls[0][0].ownership).toBe('OBSERVE_ONLY');
  });

  it('reports one bucket per entry — the four counts always account for the whole roster', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([
      watched('t1'),
      watched('t2'),
      watched('t3', { watched: false }),
      watched('t4'),
    ]);
    t.evaluate
      .mockReturnValueOnce({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'FIRE' as const })
      .mockReturnValueOnce({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null })
      .mockReturnValueOnce({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'FIRE' as const });
    t.judge.mockRejectedValueOnce(new Error('agent refused'));

    const report = await t.svc.runForUser(USER);

    expect(report).toEqual({ evaluated: 1, skipped: 1, failed: 1, unwatched: 1 });
    expect(report.evaluated + report.skipped + report.failed + report.unwatched).toBe(4);
  });
});

describe('SentinelCycleService — recording a verdict', () => {
  it('records the verdict, the packet, the prompt version and what woke it', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.evaluate.mockReturnValue({
      fires: [{ name: 'level-break', detail: 'lost 100' }],
      heartbeat: false,
      shouldEvaluate: true,
    });

    const report = await t.svc.runForUser(USER);

    expect(t.record).toHaveBeenCalledTimes(1);
    const recorded = t.record.mock.calls[0][0];
    expect(recorded).toMatchObject({
      userId: USER,
      trackerId: 't1',
      symbol: 'T1',
      verdict: 'HOLD',
      confidence: 'high',
      thesisStatus: 'INTACT',
      recoveryAvailable: true,
      reason: 'ok',
      evidence: ['money.netPnl'],
      invalidationPoint: 'x',
      reviewInSec: 300,
      triggeredBy: ['level-break'],
      netPnl: 42,
      greenFloor: 101.5,
    });
    // Stamped from the agent, never a literal — Task 13 attributes a behaviour
    // change to a prompt change by diffing exactly this field.
    expect(recorded.promptVersion).toBe('sentinel-v3');
    // The packet is stored by reference, as the evidence the agent actually saw.
    expect(recorded.packet).toBe(await t.buildPacket.mock.results[0].value);
    expect(report.evaluated).toBe(1);
  });

  it('names every sensor that fired, not just the first', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.evaluate.mockReturnValue({
      fires: [
        { name: 'level-break', detail: 'a' },
        { name: 'volume-anomaly', detail: 'b' },
      ],
      heartbeat: true,
      shouldEvaluate: true,
    });

    await t.svc.runForUser(USER);

    expect(t.record.mock.calls[0][0].triggeredBy).toEqual(['level-break', 'volume-anomaly']);
  });

  it('attributes a sensorless wake to the heartbeat', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'FIRE' as const });

    await t.svc.runForUser(USER);

    expect(t.record.mock.calls[0][0].triggeredBy).toEqual(['heartbeat']);
  });

  it('takes the tenant from the roster entry, not from the argument', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1', { userId: 'tenant-from-entry' })]);

    await t.svc.runForUser(USER);

    expect(t.record.mock.calls[0][0].userId).toBe('tenant-from-entry');
  });

  it('passes the last verdict time to the heartbeat clock, and null on first sight', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    expect(t.evaluate.mock.calls[0][1]).toBeNull();
    expect(t.evaluate.mock.calls[0][2]).toBe(now);

    const last = verdictRow();
    t.recentForTracker.mockResolvedValue([last]);
    await t.svc.runForUser(USER, now);
    expect(t.evaluate.mock.calls[1][1]).toBe(last.createdAt);
  });
});

describe('SentinelCycleService — failure isolation', () => {
  it.each([
    ['the tick source', (t: ReturnType<typeof makeSvc>) => t.tickFor],
    ['the agent', (t: ReturnType<typeof makeSvc>) => t.judge],
    ['the packet builder', (t: ReturnType<typeof makeSvc>) => t.buildPacket],
    ['the verdict write', (t: ReturnType<typeof makeSvc>) => t.record],
    ['the OI snapshot', (t: ReturnType<typeof makeSvc>) => t.captureAndCompare],
    ['the thesis service', (t: ReturnType<typeof makeSvc>) => t.ensureFor],
  ])('a failure in %s on one position still evaluates the next', async (_label, pick) => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1'), watched('t2')]);
    t.tickFor.mockResolvedValue(tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000 }));
    pick(t).mockRejectedValueOnce(new Error('boom'));

    const report = await t.svc.runForUser(USER);

    expect(report.failed).toBe(1);
    expect(report.evaluated).toBe(1);
    // Not merely "counted": the survivor was carried all the way to a written
    // verdict. (Filtered rather than counted, because when the write itself is
    // the injected failure the doomed position also reaches `record` — once.)
    const written = t.record.mock.calls.filter((c) => c[0].trackerId === 't2');
    expect(written).toHaveLength(1);
  });

  it('a roster failure fails the whole run rather than reporting a silent empty cycle', async () => {
    const t = makeSvc();
    t.build.mockRejectedValue(new Error('trade-tracker down'));

    await expect(t.svc.runForUser(USER)).rejects.toThrow('trade-tracker down');
  });
});

describe('SentinelCycleService — shadow mode is structural', () => {
  const FORBIDDEN = /execution|order|broker|angel|smart-?api|trade-engine|auto-trade/i;

  /**
   * How an import specifier is recognised while walking the graph. BOTH quote
   * styles — a single-quote-only pattern is a hole the whole guard falls
   * through. One double-quoted import, which a formatter change or a hand edit
   * produces without comment, is invisible to the walk; the edge it hides is
   * never followed, so the entire subgraph beyond it goes unchecked while the
   * suite stays green. The guard would then report the property rather than
   * enforce it, which is precisely what the transitive walk exists to avoid.
   *
   * Extracted and asserted directly below, because the repo happens to contain
   * no double-quoted imports today — so widening the pattern changes no
   * behaviour that any graph-walking test could observe.
   */
  const IMPORT_SPECIFIER = /from\s+['"]([^'"]+)['"]/g;

  it('recognises an import specifier in either quote style', () => {
    const specs = (src: string) => [...src.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]);
    expect(specs("import { a } from './single';")).toEqual(['./single']);
    expect(specs('import { a } from "./double";')).toEqual(['./double']);
    expect(specs('export type { T } from "../far/away";')).toEqual(['../far/away']);
    // And the two together, in the order they appear.
    expect(specs("import a from './x';\nimport b from \"./y\";")).toEqual(['./x', './y']);
  });
  /**
   * Both anchors, because the cycle is the object under test but the RUNNER is
   * what production actually calls.
   *
   * `SentinelRunnerService` is what the scheduler invokes every 30 seconds; the
   * cycle is reached through it. Walking only the cycle would leave the
   * scheduler's own dependency graph unchecked, so an executor injected there —
   * one hop from every tick — would satisfy this test while defeating it
   * entirely. It costs one array element to keep the property attached to the
   * thing that runs.
   *
   * The replay harness is the third anchor. It has no runtime imports today, so
   * this is free — but it is the module's natural place to grow a CLI or an
   * endpoint (nothing invokes it yet), and by the same argument as above a
   * production entry point outside the walk defeats the walk. Anchoring it now
   * costs nothing and cannot be forgotten later.
   */
  const ENTRIES = [
    join(__dirname, 'sentinel-cycle.service.ts'),
    join(__dirname, 'sentinel-runner.service.ts'),
    join(__dirname, '..', 'replay', 'replay-verdicts.ts'),
  ];

  /**
   * Every module reachable from the cycle by following relative imports, with
   * the trail that reached it.
   *
   * TRANSITIVE, not first-hop. The earlier version of this test scanned only
   * `sentinel-cycle.service.ts` and passed while `RosterService` ->
   * `TradeTrackerService` -> `angel-one-adapter.service` (placeOrder,
   * modifyOrder, cancelOrder) was reachable at runtime from any live cycle
   * instance, and while `OiWallSnapshotService` -> `OiWallService` ->
   * `OptionsChainService` -> the market feed reached the same adapter by a
   * second, independent route. A first-hop check cannot see either, which makes
   * it a check that reports the property rather than enforcing it.
   *
   * Type-only imports are followed too, even though they are erased at runtime
   * and cannot make anything reachable. That is deliberate over-strictness: a
   * `import type` is one keyword away from a value import, and the cost of the
   * false positive is a port that was going to be worth extracting anyway.
   */
  function reachable(): Array<{ file: string; trail: string[] }> {
    const seen = new Set<string>();
    const out: Array<{ file: string; trail: string[] }> = [];
    const stack: Array<{ file: string; trail: string[] }> = ENTRIES.map((e) => ({
      file: e,
      trail: [e],
    }));

    const resolve = (from: string, spec: string): string | null => {
      if (!spec.startsWith('.')) return null; // package import; not part of our graph
      const base = join(dirname(from), spec);
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) return candidate;
      }
      return null;
    };

    while (stack.length > 0) {
      const node = stack.pop() as { file: string; trail: string[] };
      if (seen.has(node.file)) continue;
      seen.add(node.file);
      out.push(node);
      for (const m of readFileSync(node.file, 'utf8').matchAll(IMPORT_SPECIFIER)) {
        const spec = m[1];
        // The specifier itself is checked even when it does not resolve to a
        // file in this repo, so a package like `smartapi-javascript` is caught.
        if (FORBIDDEN.test(spec)) {
          out.push({ file: spec, trail: [...node.trail, spec] });
          continue;
        }
        const next = resolve(node.file, spec);
        if (next && !seen.has(next)) stack.push({ file: next, trail: [...node.trail, next] });
      }
    }
    return out;
  }

  it('every entry point exists, so the walk cannot start from nothing', () => {
    for (const entry of ENTRIES) expect(existsSync(entry)).toBe(true);
  });

  it('cannot reach anything that places an order, however many hops away', () => {
    const graph = reachable();
    // Guard against the walker silently resolving nothing and passing vacuously.
    expect(graph.length).toBeGreaterThan(10);
    // Both anchors were actually walked. Named LITERALLY rather than iterated
    // over ENTRIES: an assertion driven by the same array it is checking passes
    // happily after someone deletes an entry from it, which is precisely the
    // regression worth catching — the runner is what the scheduler calls, and
    // dropping it from the walk would silently unguard the production entry
    // point while every test stayed green.
    const files = graph.map((n) => n.file);
    expect(files).toContain(join(__dirname, 'sentinel-cycle.service.ts'));
    expect(files).toContain(join(__dirname, 'sentinel-runner.service.ts'));
    expect(files).toContain(join(__dirname, '..', 'replay', 'replay-verdicts.ts'));

    const offenders = graph
      .filter((n) => FORBIDDEN.test(n.file))
      .map((n) => n.trail.map((t) => t.replace(/^.*[\\/]src[\\/]/, 'src/')).join('\n    -> '));

    expect(offenders).toEqual([]);
  });

  it('the guard is live — it catches a reintroduced path', () => {
    // The property is only as good as the walker. Prove the walker actually
    // follows edges by running it from a file that IS on such a path: if this
    // returns nothing, the test above is vacuous and would keep passing after
    // someone re-points the roster at TradeTrackerService.
    const withRealPath = join(
      __dirname,
      '..',
      '..',
      'trade-tracker',
      'services',
      'trade-tracker.service.ts',
    );
    expect(existsSync(withRealPath)).toBe(true);
    const specs = [...readFileSync(withRealPath, 'utf8').matchAll(/from\s+'([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(specs.some((s) => FORBIDDEN.test(s))).toBe(true);
  });

  it('exposes no method through which an order could be placed', () => {
    const t = makeSvc();
    const surface = [
      ...Object.getOwnPropertyNames(t.svc),
      ...Object.getOwnPropertyNames(SentinelCycleService.prototype),
    ];
    for (const name of surface) {
      expect(name).not.toMatch(/execute|placeOrder|squareOff|exitPosition|closePosition|submit/i);
    }
  });

  it('injects nothing that could place an order', () => {
    // Read off the constructor's emitted paramtypes rather than a hand-kept list,
    // so ADDING an order-placing collaborator fails this test rather than needing
    // someone to remember to extend it.
    const injected: unknown[] =
      (Reflect as { getMetadata?: (k: string, t: unknown) => unknown[] }).getMetadata?.(
        'design:paramtypes',
        SentinelCycleService,
      ) ?? [];
    expect(injected).toHaveLength(8);
    // `TickSource` is an interface, so paramtypes emits Object for it and Nest
    // cannot resolve it by type. Without an explicit token Task 12 could not
    // register an adapter without editing this file.
    const byToken: Array<{ index: number; param: unknown }> =
      (Reflect as { getMetadata?: (k: string, t: unknown) => unknown }).getMetadata?.(
        'self:paramtypes',
        SentinelCycleService,
      ) as never;
    expect(byToken).toEqual(
      expect.arrayContaining([expect.objectContaining({ index: 7, param: TICK_SOURCE })]),
    );

    for (const dep of injected) {
      if (typeof dep !== 'function') continue; // `TickSource` is an interface: emitted as Object.
      const name = (dep as { name: string }).name;
      expect(name).not.toMatch(/execution|order|broker|trade-?engine|auto-?trade/i);
      for (const method of Object.getOwnPropertyNames((dep as { prototype: object }).prototype)) {
        expect(method).not.toMatch(/^(execute|placeOrder|squareOff|cancelOrder|modifyOrder)$/i);
      }
    }
  });
});

describe('previousFactorValues', () => {
  it('is empty with no previous verdict — nothing can have flipped on first sight', () => {
    expect(previousFactorValues(undefined)).toEqual({});
    expect(previousFactorValues(null)).toEqual({});
  });

  it('is empty when the previous packet stated the factors were unavailable', () => {
    expect(
      previousFactorValues({ packet: { macro: { realFactors: { available: false, reason: 'x' } } } }),
    ).toEqual({});
  });

  it('returns the finite readings the agent last saw', () => {
    expect(
      previousFactorValues({
        packet: { macro: { realFactors: { available: true, value: { mtfTrend: 0.4, iv: -0.2 } } } },
      }),
    ).toEqual({ mtfTrend: 0.4, iv: -0.2 });
  });

  it('drops non-finite and non-numeric readings — a NaN baseline manufactures a flip', () => {
    expect(
      previousFactorValues({
        packet: {
          macro: {
            realFactors: {
              available: true,
              value: { good: 0.5, nan: NaN, inf: Infinity, text: '0.5', nil: null },
            },
          },
        },
      }),
    ).toEqual({ good: 0.5 });
  });

  it.each([
    ['a null packet', { packet: null }],
    ['a string packet', { packet: 'corrupt' }],
    ['a packet with no macro', { packet: {} }],
    ['an array-valued factor block', { packet: { macro: { realFactors: { available: true, value: [1, 2] } } } }],
    ['a null-valued factor block', { packet: { macro: { realFactors: { available: true, value: null } } } }],
  ])('degrades %s to no baseline rather than throwing', (_label, last) => {
    expect(previousFactorValues(last)).toEqual({});
  });

  it('is actually wired: the sensors receive the previous packet as their baseline', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.recentForTracker.mockResolvedValue([
      verdictRow({
        packet: {
          money: { greenFloorArmed: false },
          macro: { realFactors: { available: true, value: { mtfTrend: 0.8 } } },
        },
      }),
    ]);
    t.tickFor.mockResolvedValue(tick({ factorValues: { mtfTrend: -0.8 } }));

    await t.svc.runForUser(USER);

    // The bug this guards: an earlier draft hardcoded `prevFactorValues: {}`, so
    // contextFactorFlip could never fire no matter what the factors did.
    expect(tripwireInput(t.evaluate).prevFactorValues).toEqual({ mtfTrend: 0.8 });
    expect(tripwireInput(t.evaluate).factorValues).toEqual({ mtfTrend: -0.8 });
  });
});

describe('SentinelCycleService — the green-floor latch', () => {
  /** entry 100 x 10 at ltp 120 nets ~₹193, well clear of the ₹150 margin. */
  const ARMED_LTP = 120;

  it('does not claim a floor that has never armed', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ ltp: 100 }));

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(false);
  });

  it('arms on the tick that clears the margin', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ ltp: ARMED_LTP }));

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(true);
  });

  it('stays armed through a pullback back into the red', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);

    t.tickFor.mockResolvedValue(tick({ ltp: ARMED_LTP }));
    await t.svc.runForUser(USER);

    // The position gives it all back and is now LOSING. The floor must not un-arm.
    t.tickFor.mockResolvedValue(tick({ ltp: 90 }));
    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[1][1].greenFloorArmedLatched).toBe(true);
  });

  it('latches an arming that happened on a tick no verdict was written for', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);

    // Tick 1: armed, but every sensor quiet and the heartbeat not due — no verdict
    // row exists to carry the latch, so only the in-process ratchet can hold it.
    t.evaluate.mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null });
    t.tickFor.mockResolvedValue(tick({ ltp: ARMED_LTP }));
    await t.svc.runForUser(USER);
    expect(t.buildPacket).not.toHaveBeenCalled();

    // Tick 2: pulled back below the margin, heartbeat due.
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'FIRE' as const });
    t.tickFor.mockResolvedValue(tick({ ltp: 101 }));
    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(true);
  });

  it('recovers the latch from the last stored packet after a restart', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    // Fresh instance: no in-process state at all. A LOSING position whose floor
    // armed before the restart.
    t.tickFor.mockResolvedValue(tick({ ltp: 90 }));
    t.recentForTracker.mockResolvedValue([
      verdictRow({ packet: { money: { greenFloorArmed: true } } }),
    ]);

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(true);
  });

  it('does not invent a latch from an unreadable stored packet', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ ltp: 100 }));
    t.recentForTracker.mockResolvedValue([verdictRow({ packet: 'corrupt' })]);

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(false);
  });

  it('does not leak one position’s latch onto another', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1'), watched('t2')]);
    t.tickFor.mockImplementation((id: string) =>
      Promise.resolve(tick({ ltp: id === 't1' ? ARMED_LTP : 100 })),
    );

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(true);
    expect(t.buildPacket.mock.calls[1][1].greenFloorArmedLatched).toBe(false);
  });

  it('forgets a tracker once it leaves the roster, so a reused id starts clean', async () => {
    const t = makeSvc();
    t.tickFor.mockResolvedValue(tick({ ltp: ARMED_LTP }));
    t.build.mockResolvedValue([watched('t1')]);
    await t.svc.runForUser(USER);

    // Position closed — off the roster entirely.
    t.build.mockResolvedValue([]);
    await t.svc.runForUser(USER);

    // A new position on the same tracker id, unarmed and with no verdict history.
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ ltp: 100 }));
    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[1][1].greenFloorArmedLatched).toBe(false);
  });

  it('keeps another tenant’s state when pruning this one', async () => {
    const t = makeSvc();
    t.tickFor.mockResolvedValue(tick({ ltp: ARMED_LTP }));
    t.build.mockResolvedValue([watched('t9', { userId: 'other' })]);
    await t.svc.runForUser('other');

    // A run for a different tenant must not sweep 'other's tracker out.
    t.build.mockResolvedValue([]);
    await t.svc.runForUser(USER);

    t.build.mockResolvedValue([watched('t9', { userId: 'other' })]);
    t.tickFor.mockResolvedValue(tick({ ltp: 90 }));
    await t.svc.runForUser('other');

    expect(t.buildPacket.mock.calls[1][1].greenFloorArmedLatched).toBe(true);
  });
});

describe('storedFloorArmed', () => {
  it.each([
    ['no verdict', undefined, false],
    ['an armed packet', { packet: { money: { greenFloorArmed: true } } }, true],
    ['an unarmed packet', { packet: { money: { greenFloorArmed: false } } }, false],
    ['a missing money block', { packet: {} }, false],
    ['a truthy non-boolean', { packet: { money: { greenFloorArmed: 'yes' } } }, false],
    ['a corrupt packet', { packet: 7 }, false],
  ])('reads %s as %s', (_label, last, expected) => {
    expect(storedFloorArmed(last as { packet?: unknown } | undefined)).toBe(expected);
  });
});

describe('withCashUnderlying', () => {
  it.each(['EQ_DELIVERY', 'EQ_INTRADAY'] as const)(
    'gives a %s tick an underlying equal to its own ltp',
    (segment) => {
      const out = withCashUnderlying(tick({ segment, ltp: 1450, underlyingLtp: null }));
      expect(out.underlyingLtp).toBe(1450);
    },
  );

  it.each(['OPT', 'FUT'] as const)(
    'leaves a %s tick without an underlying — the premium is not the spot',
    (segment) => {
      const out = withCashUnderlying(tick({ segment, ltp: 120, underlyingLtp: null }));
      expect(out.underlyingLtp).toBeNull();
    },
  );

  it('does not overwrite an underlying the source already resolved', () => {
    const out = withCashUnderlying(tick({ segment: 'EQ_INTRADAY', ltp: 1450, underlyingLtp: 1449 }));
    expect(out.underlyingLtp).toBe(1449);
  });

  it('repairs a NaN underlying, which is not a reading either', () => {
    const out = withCashUnderlying(tick({ segment: 'EQ_INTRADAY', ltp: 1450, underlyingLtp: NaN }));
    expect(out.underlyingLtp).toBe(1450);
  });

  it('is wired: an equity position reaches the sensors with a comparable underlying', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'EQ_INTRADAY', ltp: 1450, underlyingLtp: null, nearestSupport: 1440 }),
    );

    await t.svc.runForUser(USER);

    // Without this, levelBreak is silent on EVERY equity position and it looks
    // exactly like the level was never touched.
    expect(tripwireInput(t.evaluate).underlyingLtp).toBe(1450);
  });

  it('does not repair silently — a tick source that omits it is reported, once', async () => {
    const t = makeSvc();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      t.build.mockResolvedValue([watched('t1')]);
      t.tickFor.mockResolvedValue(tick({ segment: 'EQ_INTRADAY', underlyingLtp: null }));

      await t.svc.runForUser(USER);
      await t.svc.runForUser(USER);

      // A repair that logs nothing lets a broken Task 12 adapter look permanently
      // healthy. Once per tracker, not per tick — the same warn-once discipline
      // OiWallSnapshotService already uses in this module.
      const hits = warn.mock.calls.filter((c) => /underlyingLtp/.test(String(c[0])));
      expect(hits).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing when the tick source did its job', async () => {
    const t = makeSvc();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      t.build.mockResolvedValue([watched('t1')]);
      t.tickFor.mockResolvedValue(tick({ segment: 'EQ_INTRADAY', ltp: 1450, underlyingLtp: 1450 }));

      await t.svc.runForUser(USER);

      expect(warn.mock.calls.filter((c) => /underlyingLtp/.test(String(c[0])))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('SentinelCycleService — the tripwire input', () => {
  it('delivers every field to the sensors, with nothing dropped or crossed over', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    // Every value distinct, so a field copied from the wrong source is visible
    // rather than accidentally equal to the right one.
    t.tickFor.mockResolvedValue(
      tick({
        segment: 'FUT',
        side: 'SHORT',
        entryPrice: 24011,
        qty: 75,
        ltp: 24022,
        underlyingLtp: 24033,
        holdingHigh: 24044,
        holdingLow: 24055,
        nearestSupport: 24066,
        nearestResistance: 24077,
        volumeRatio: 1.88,
        freshNewsCount: 9,
        factorValues: { mtfTrend: 0.11 },
        expiry: '2026-08-27',
      }),
    );
    t.recentForTracker.mockResolvedValue([
      verdictRow({
        packet: {
          money: { greenFloorArmed: false },
          macro: { realFactors: { available: true, value: { mtfTrend: -0.22 } } },
        },
      }),
    ]);
    const walls = { now: { callWall: 24200, putWall: 23800 }, prev: { callWall: 24500, putWall: 23700 } };
    t.captureAndCompare.mockResolvedValue(walls);

    await t.svc.runForUser(USER);

    // toEqual on the WHOLE object, not toMatchObject: the input is an 18-field
    // hand-copied literal, and dropping any one field makes a sensor go silent in
    // exactly the way `types.ts` says a sensor must go silent when it cannot see
    // — indistinguishable from "nothing happened". An extra field fails too,
    // which is what forces this test to be updated deliberately.
    expect(tripwireInput(t.evaluate)).toEqual({
      trackerId: 't1',
      symbol: 'T1',
      segment: 'FUT',
      side: 'SHORT',
      entryPrice: 24011,
      qty: 75,
      ltp: 24022,
      underlyingLtp: 24033,
      holdingHigh: 24044,
      holdingLow: 24055,
      nearestSupport: 24066,
      nearestResistance: 24077,
      volumeRatio: 1.88,
      oiWallNow: walls.now,
      oiWallPrev: walls.prev,
      freshNewsCount: 9,
      factorValues: { mtfTrend: 0.11 },
      prevFactorValues: { mtfTrend: -0.22 },
    });
  });
});

describe('SentinelCycleService — OI walls', () => {
  it('does not snapshot a symbol with no expiry', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ expiry: null }));

    await t.svc.runForUser(USER);

    expect(t.captureAndCompare).not.toHaveBeenCalled();
    expect(tripwireInput(t.evaluate).oiWallNow).toBeNull();
  });

  it('passes the symbol, the expiry and the UNDERLYING spot — never the premium', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', ltp: 120, underlyingLtp: 24000, expiry: '2026-08-27' }),
    );

    await t.svc.runForUser(USER);

    // Three required arguments. A premium here would keep ITM strikes and write a
    // mis-sided wall that poisons the next comparison.
    expect(t.captureAndCompare).toHaveBeenCalledWith('T1', '2026-08-27', 24000);
  });

  it('passes a null spot through as null rather than substituting the premium', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', ltp: 120, underlyingLtp: null, expiry: '2026-08-27' }),
    );

    await t.svc.runForUser(USER);

    expect(t.captureAndCompare).toHaveBeenCalledWith('T1', '2026-08-27', null);
  });

  it('captures on its own cadence, not on the poll rate', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000 }),
    );
    const now = new Date('2026-08-14T06:00:00.000Z');

    // A 5-second poll. Capturing on every one of these would pin oiWallPrev to
    // the reading 5s ago — the window would be NARROWER, not wider, and a wall
    // flapping between two adjacent strikes (one Nifty step at 24000 is 0.208%,
    // just over the sensor's 0.2% threshold) would wake the agent continuously.
    for (let i = 0; i < 6; i += 1) {
      await t.svc.runForUser(USER, new Date(now.getTime() + i * 5_000));
    }
    expect(t.captureAndCompare).toHaveBeenCalledTimes(1);

    await t.svc.runForUser(USER, new Date(now.getTime() + OI_CAPTURE_INTERVAL_MS));
    expect(t.captureAndCompare).toHaveBeenCalledTimes(2);
  });

  it('serves the last captured walls between captures — never a hole', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000 }),
    );
    const walls = { now: { callWall: 24200, putWall: 23800 }, prev: null };
    t.captureAndCompare.mockResolvedValue(walls);
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + 5_000));

    // A null pair here would make oiWallShift watch the walls blink in and out,
    // and the packet would report "no options chain" for a symbol that has one.
    expect(tripwireInput(t.evaluate, 1).oiWallNow).toBe(walls.now);
    expect(t.buildPacket.mock.calls[1][1].oiWallNow).toBe(walls.now);
  });

  it('captures per position, not per cycle', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1'), watched('t2')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000 }),
    );

    await t.svc.runForUser(USER, new Date('2026-08-14T06:00:00.000Z'));

    expect(t.captureAndCompare).toHaveBeenCalledTimes(2);
  });

  it('feeds the captured walls to both the sensors and the packet', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', underlyingLtp: 24000, expiry: '2026-08-27' }),
    );
    const now = { callWall: 24200, putWall: 23800 };
    const prev = { callWall: 24500, putWall: 23800 };
    t.captureAndCompare.mockResolvedValue({ now, prev });

    await t.svc.runForUser(USER);

    expect(tripwireInput(t.evaluate).oiWallNow).toBe(now);
    expect(tripwireInput(t.evaluate).oiWallPrev).toBe(prev);
    // The packet must see the same walls the sensor fired on, not the tick's stale nulls.
    expect(t.buildPacket.mock.calls[0][1].oiWallNow).toBe(now);
    expect(t.buildPacket.mock.calls[0][1].oiWallPrev).toBe(prev);
  });
});

describe('wallKey / suppressRepeatWallShift', () => {
  const pair = (c: number | null, p: number | null) => ({ callWall: c, putWall: p });
  const decision = (names: string[], heartbeat = false): TripwireResult => ({
    fires: names.map((name) => ({ name, detail: 'd' })),
    heartbeat,
    shouldEvaluate: names.length > 0 || heartbeat,
    // Mirrors the service: a fire outranks the heartbeat, and the trigger is
    // null only when nothing wakes the agent at all.
    trigger: names.length > 0 ? 'FIRE' : heartbeat ? 'HEARTBEAT' : null,
  });

  it('distinguishes a moved wall from an unmoved one', () => {
    const a = wallKey({ now: pair(24200, 23800), prev: pair(24500, 23800) });
    expect(wallKey({ now: pair(24200, 23800), prev: pair(24500, 23800) })).toBe(a);
    expect(wallKey({ now: pair(24300, 23800), prev: pair(24500, 23800) })).not.toBe(a);
    // The PREVIOUS side matters too: same walls now, different transition.
    expect(wallKey({ now: pair(24200, 23800), prev: pair(24100, 23800) })).not.toBe(a);
  });

  it('never produces a key for absent walls, so absence cannot suppress', () => {
    expect(wallKey({ now: null, prev: null })).toBeNull();
    expect(wallKey({ now: null, prev: pair(1, 2) })).toBeNull();
  });

  it('drops a repeated wall-shift fire and re-decides whether to wake', () => {
    const out = suppressRepeatWallShift(decision(['oi-wall-shift']), 'k', 'k');
    expect(out.fires).toEqual([]);
    expect(out.shouldEvaluate).toBe(false);
  });

  it('keeps the fire when the transition is a new one', () => {
    const out = suppressRepeatWallShift(decision(['oi-wall-shift']), 'k2', 'k1');
    expect(out.fires).toHaveLength(1);
    expect(out.shouldEvaluate).toBe(true);
  });

  it('still wakes when another sensor fired alongside it', () => {
    const out = suppressRepeatWallShift(decision(['oi-wall-shift', 'level-break']), 'k', 'k');
    expect(out.fires.map((f) => f.name)).toEqual(['level-break']);
    expect(out.shouldEvaluate).toBe(true);
  });

  it('never suppresses the heartbeat', () => {
    const out = suppressRepeatWallShift(decision(['oi-wall-shift'], true), 'k', 'k');
    expect(out.fires).toEqual([]);
    // The scheduled look exists to catch what the sensors miss; a de-duplication
    // that cancelled it would make a quiet position invisible.
    expect(out.shouldEvaluate).toBe(true);
  });

  it('leaves other sensors alone — they read inputs that move on their own', () => {
    const d = decision(['volume-anomaly']);
    expect(suppressRepeatWallShift(d, 'k', 'k')).toBe(d);
  });
});

describe('SentinelCycleService — a wall shift wakes the agent once, not every tick', () => {
  const optTick = () =>
    tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000 });

  function shifting() {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(optTick());
    t.captureAndCompare.mockResolvedValue({
      now: { callWall: 24200, putWall: 23800 },
      prev: { callWall: 24500, putWall: 23800 },
    });
    t.evaluate.mockReturnValue({
      fires: [{ name: 'oi-wall-shift', detail: 'call wall 24500 -> 24200' }],
      heartbeat: false,
      shouldEvaluate: true,
    });
    return t;
  }

  it('does not re-judge the same transition while the pair is being reused', async () => {
    const t = shifting();
    const now = new Date('2026-08-14T06:00:00.000Z');

    // A 5s poll across the 60s reuse window. The sensors are pure and the served
    // pair is identical, so without de-duplication this is ~12 agent calls for
    // one shift — which would eat most of the saving the cadence change bought.
    for (let i = 0; i < 12; i += 1) {
      await t.svc.runForUser(USER, new Date(now.getTime() + i * 5_000));
    }

    expect(t.judge).toHaveBeenCalledTimes(1);
    expect(t.captureAndCompare).toHaveBeenCalledTimes(1);
  });

  it('wakes again as soon as the walls actually move', async () => {
    const t = shifting();
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + 5_000));
    expect(t.judge).toHaveBeenCalledTimes(1);

    // Next capture window, and the walls have moved again.
    t.captureAndCompare.mockResolvedValue({
      now: { callWall: 24100, putWall: 23800 },
      prev: { callWall: 24200, putWall: 23800 },
    });
    await t.svc.runForUser(USER, new Date(now.getTime() + OI_CAPTURE_INTERVAL_MS));

    expect(t.judge).toHaveBeenCalledTimes(2);
  });

  it('still lets the heartbeat through on a repeated transition', async () => {
    const t = shifting();
    const now = new Date('2026-08-14T06:00:00.000Z');
    await t.svc.runForUser(USER, now);

    t.evaluate.mockReturnValue({
      fires: [{ name: 'oi-wall-shift', detail: 'same' }],
      heartbeat: true,
      shouldEvaluate: true,
    });
    await t.svc.runForUser(USER, new Date(now.getTime() + 5_000));

    expect(t.judge).toHaveBeenCalledTimes(2);
    // Attributed to the heartbeat, since the suppressed fire is no longer a cause.
    expect(t.record.mock.calls[1][0].triggeredBy).toEqual(['heartbeat']);
  });

  it('de-duplicates per position', async () => {
    const t = shifting();
    t.build.mockResolvedValue([watched('t1'), watched('t2')]);
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + 5_000));

    expect(t.judge).toHaveBeenCalledTimes(2); // one each on the first run only
  });
});

describe('SentinelCycleService — OI provenance', () => {
  it('stamps the walls with when they were CAPTURED, not when the packet was built', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000 }),
    );
    t.captureAndCompare.mockResolvedValue({ now: { callWall: 24200, putWall: 23800 }, prev: null });
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    expect(t.buildPacket.mock.calls[0][1].oiWallsAt).toBe(now.toISOString());

    // 45s later the pair is being reused. Reporting THIS tick's time would tell
    // the agent a 45-second-old reading is current, on the one block in the
    // packet that is not.
    await t.svc.runForUser(USER, new Date(now.getTime() + 45_000));
    expect(t.buildPacket.mock.calls[1][1].oiWallsAt).toBe(now.toISOString());

    // A fresh capture carries its own time.
    await t.svc.runForUser(USER, new Date(now.getTime() + OI_CAPTURE_INTERVAL_MS));
    expect(t.buildPacket.mock.calls[2][1].oiWallsAt).toBe(
      new Date(now.getTime() + OI_CAPTURE_INTERVAL_MS).toISOString(),
    );
  });

  it('carries no wall time when the symbol has no chain', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ expiry: null }));

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].oiWallsAt).toBeNull();
  });
});

describe('SentinelCycleService — thesis', () => {
  it('calls ensureFor with the entry and the tick — the userId argument is gone', async () => {
    const t = makeSvc();
    const entry = watched('t1');
    t.build.mockResolvedValue([entry]);

    await t.svc.runForUser(USER);

    expect(t.ensureFor).toHaveBeenCalledTimes(1);
    expect(t.ensureFor.mock.calls[0]).toHaveLength(2);
    expect(t.ensureFor.mock.calls[0][0]).toBe(entry);
    expect(t.ensureFor.mock.calls[0][1]).toMatchObject({ side: 'LONG', entryPrice: 100, qty: 10 });
  });

  it('hands the thesis to the packet builder, keeping the disagreement flag', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const ensured = { ...inferredThesis(), modelDirectionDisagreed: true as const };
    t.ensureFor.mockResolvedValue(ensured);

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][2]).toBe(ensured);
    expect(t.buildPacket.mock.calls[0][2].modelDirectionDisagreed).toBe(true);
  });

  it('hands the fires to the packet builder as the trigger', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const fires = [{ name: 'news-hit', detail: '3 headlines' }];
    t.evaluate.mockReturnValue({ fires, heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' as const });

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][3]).toBe(fires);
  });

  it('re-asks on every look while the thesis is real, so a user correction lands at once', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + 1000));

    expect(t.ensureFor).toHaveBeenCalledTimes(2);
  });

  it('does not re-infer a placeholder thesis at tick cadence', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.ensureFor.mockResolvedValue(placeholderThesis());
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    // Ten seconds later, and again a minute later. ensureFor re-infers on EVERY
    // call while the stored thesis is the placeholder, with no cooldown of its
    // own — the cadence has to be held here.
    await t.svc.runForUser(USER, new Date(now.getTime() + 10_000));
    await t.svc.runForUser(USER, new Date(now.getTime() + 60_000));

    expect(t.ensureFor).toHaveBeenCalledTimes(1);
    // The held-back look still gets a thesis — a stale placeholder, never nothing.
    expect(t.buildPacket).toHaveBeenCalledTimes(3);
    expect(t.buildPacket.mock.calls[2][2].reason).toMatch(/^thesis could not be inferred/);
  });

  it('tries again once the cooldown has elapsed', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.ensureFor.mockResolvedValue(placeholderThesis());
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + THESIS_RETRY_COOLDOWN_MS));

    expect(t.ensureFor).toHaveBeenCalledTimes(2);
  });

  it('resumes asking as soon as inference succeeds', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const now = new Date('2026-08-14T06:00:00.000Z');

    t.ensureFor.mockResolvedValueOnce(placeholderThesis());
    await t.svc.runForUser(USER, now);

    // Held back...
    await t.svc.runForUser(USER, new Date(now.getTime() + 1000));
    expect(t.ensureFor).toHaveBeenCalledTimes(1);

    // ...until the cooldown lapses and a real thesis comes back, after which
    // there is nothing left to hold back.
    t.ensureFor.mockResolvedValue(inferredThesis());
    await t.svc.runForUser(USER, new Date(now.getTime() + THESIS_RETRY_COOLDOWN_MS));
    await t.svc.runForUser(USER, new Date(now.getTime() + THESIS_RETRY_COOLDOWN_MS + 1000));
    expect(t.ensureFor).toHaveBeenCalledTimes(3);
  });

  // NAME PINS THE ACTUAL PROPERTY: an ALREADY-corrected thesis is never cooled
  // down. That is weaker than "a correction lands at once" — for the case this
  // does NOT cover, see 'does not see a correction made while a placeholder is
  // cooling down' below.
  it('does not cool down a thesis the user has already corrected', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.ensureFor.mockResolvedValue({ ...placeholderThesis(), source: 'USER' });
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + 1000));

    expect(t.ensureFor).toHaveBeenCalledTimes(2);
  });

  it('cools down each position independently', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1'), watched('t2')]);
    t.ensureFor.mockResolvedValueOnce(placeholderThesis()).mockResolvedValue(inferredThesis());
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + 1000));

    // t1 held back, t2 re-asked: 2 on the first run, 1 on the second.
    expect(t.ensureFor).toHaveBeenCalledTimes(3);
    expect(t.ensureFor.mock.calls[2][0].trackerId).toBe('t2');
  });

  it('is never faster than the heartbeat, whatever the heartbeat becomes', () => {
    // One-sided on purpose. Equality would let someone dropping the heartbeat to
    // one minute drag the retry cooldown down with it and 15x the cost of an
    // outage — a test that enforces the harmful direction of a coupling.
    expect(THESIS_RETRY_COOLDOWN_MS).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_MS);
  });

  it('does not see a correction made while a placeholder is cooling down', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.ensureFor.mockResolvedValue(placeholderThesis());
    const now = new Date('2026-08-14T06:00:00.000Z');
    await t.svc.runForUser(USER, now);

    // The user corrects the thesis here. The gate reads the CACHED value, which
    // is still the placeholder, so the row is not re-read and the correction is
    // not seen. This is the documented staleness bound on TrackerState.thesis —
    // pinned so that anyone changing it changes a failing test, not a comment.
    t.ensureFor.mockResolvedValue(inferredThesis({ source: 'USER', reason: 'bought the gap fill' }));
    await t.svc.runForUser(USER, new Date(now.getTime() + 60_000));
    expect(t.buildPacket.mock.calls[1][2].reason).toMatch(/^thesis could not be inferred/);

    // ...and it does land once the bound elapses.
    await t.svc.runForUser(USER, new Date(now.getTime() + THESIS_RETRY_COOLDOWN_MS));
    expect(t.buildPacket.mock.calls[2][2].reason).toBe('bought the gap fill');
  });
});

describe('SentinelCycleService — the agent-failure backoff', () => {
  it('doubles from the base and stops at the cap', () => {
    expect(agentBackoffMs(0)).toBe(0);
    expect(agentBackoffMs(1)).toBe(AGENT_RETRY_BASE_MS);
    expect(agentBackoffMs(2)).toBe(AGENT_RETRY_BASE_MS * 2);
    expect(agentBackoffMs(3)).toBe(AGENT_RETRY_BASE_MS * 4);
    expect(agentBackoffMs(6)).toBe(AGENT_RETRY_MAX_MS);
    // No overflow to Infinity, which would take the position offline for good.
    expect(agentBackoffMs(2000)).toBe(AGENT_RETRY_MAX_MS);
  });

  it('does not re-call the agent on the very next tick after a failure', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.judge.mockRejectedValue(new Error('the model refused this packet'));
    const now = new Date('2026-08-14T06:00:00.000Z');

    // A refusal writes NO verdict row, so lastVerdictAt stays null and the
    // heartbeat is permanently due. Without a backoff this is an unbounded
    // hot loop against the most expensive call in the cycle.
    const first = await t.svc.runForUser(USER, now);
    expect(first.failed).toBe(1);

    const second = await t.svc.runForUser(USER, new Date(now.getTime() + 5_000));

    expect(t.judge).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ evaluated: 0, skipped: 1, failed: 0, unwatched: 0 });
    // The whole expensive tail is suppressed, not just the agent call.
    expect(t.buildPacket).toHaveBeenCalledTimes(1);
    expect(t.ensureFor).toHaveBeenCalledTimes(1);
  });

  it('keeps the sensors, the ratchet and the OI series running while it backs off', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000, ltp: 100 }),
    );
    t.judge.mockRejectedValue(new Error('boom'));
    const now = new Date('2026-08-14T06:00:00.000Z');
    const at = (ms: number) => new Date(now.getTime() + ms);

    // Three failures walk the backoff out to two minutes, which is longer than
    // the OI capture interval — so the window below is genuinely "inside the
    // agent backoff, past the OI cadence", which no single failure can produce.
    await t.svc.runForUser(USER, at(0)); // fail 1 -> retry at 30s. OI captured.
    await t.svc.runForUser(USER, at(30_000)); // fail 2 -> retry at 90s.
    await t.svc.runForUser(USER, at(90_000)); // fail 3 -> retry at 210s. OI captured.
    expect(t.judge).toHaveBeenCalledTimes(3);

    // Deep inside the backoff, and the floor arms here.
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000, ltp: 120 }),
    );
    await t.svc.runForUser(USER, at(150_000));

    expect(t.judge).toHaveBeenCalledTimes(3);
    expect(t.evaluate).toHaveBeenCalledTimes(4);
    expect(t.captureAndCompare).toHaveBeenCalledTimes(3);
    // The three failing runs each built a packet before `judge` threw; the
    // backed-off fourth built none. That is the expensive tail being suppressed.
    expect(t.buildPacket).toHaveBeenCalledTimes(3);

    // And the ratchet kept moving underneath: the floor armed during the outage,
    // so the first packet built after recovery must already show it latched.
    t.judge.mockResolvedValue({
      verdict: 'HOLD',
      confidence: 'high',
      thesisStatus: 'INTACT',
      recoveryAvailable: true,
      reason: 'ok',
      evidence: ['money.netPnl'],
      invalidationPoint: 'x',
      reviewIn: 300,
    });
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000, ltp: 90 }),
    );
    await t.svc.runForUser(USER, at(210_000));
    expect(t.buildPacket).toHaveBeenCalledTimes(4);
    expect(t.buildPacket.mock.calls[3][1].greenFloorArmedLatched).toBe(true);
  });

  it('retries once the backoff elapses, and lengthens it on each further failure', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.judge.mockRejectedValue(new Error('boom'));
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + AGENT_RETRY_BASE_MS));
    expect(t.judge).toHaveBeenCalledTimes(2);

    // Second failure: the window is now 2x the base, so 1x is too early.
    await t.svc.runForUser(USER, new Date(now.getTime() + AGENT_RETRY_BASE_MS * 2));
    expect(t.judge).toHaveBeenCalledTimes(2);

    await t.svc.runForUser(USER, new Date(now.getTime() + AGENT_RETRY_BASE_MS * 3));
    expect(t.judge).toHaveBeenCalledTimes(3);
  });

  it('clears the backoff as soon as a verdict comes back', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const now = new Date('2026-08-14T06:00:00.000Z');

    t.judge.mockRejectedValueOnce(new Error('boom'));
    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + AGENT_RETRY_BASE_MS));
    expect(t.judge).toHaveBeenCalledTimes(2);

    // Recovered — the next tick must not still be serving the old window.
    await t.svc.runForUser(USER, new Date(now.getTime() + AGENT_RETRY_BASE_MS + 1000));
    expect(t.judge).toHaveBeenCalledTimes(3);
  });

  it('counts CONSECUTIVE failures, not cumulative ones', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const now = new Date('2026-08-14T06:00:00.000Z');
    const at = (ms: number) => new Date(now.getTime() + ms);

    t.judge.mockRejectedValueOnce(new Error('boom')); // failure 1
    await t.svc.runForUser(USER, at(0));
    await t.svc.runForUser(USER, at(AGENT_RETRY_BASE_MS)); // recovers
    expect(t.judge).toHaveBeenCalledTimes(2);

    // A later, unrelated failure must start the backoff from the BASE again. If
    // the counter merely accumulated, an occasional bad reply over a long session
    // would eventually silence a perfectly healthy position for 15 minutes at a
    // time. (This is what the success-path reset of `agentFailures` buys, and
    // nothing else in this file observes it.)
    t.judge.mockRejectedValueOnce(new Error('boom')); // failure 2, non-consecutive
    await t.svc.runForUser(USER, at(AGENT_RETRY_BASE_MS * 2));
    await t.svc.runForUser(USER, at(AGENT_RETRY_BASE_MS * 3));

    expect(t.judge).toHaveBeenCalledTimes(4);
  });

  it('announces the backoff once per window, not once per suppressed tick', async () => {
    const t = makeSvc();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      t.build.mockResolvedValue([watched('t1')]);
      t.judge.mockRejectedValue(new Error('boom'));
      const now = new Date('2026-08-14T06:00:00.000Z');

      await t.svc.runForUser(USER, now);
      for (let i = 1; i <= 5; i += 1) {
        await t.svc.runForUser(USER, new Date(now.getTime() + i * 5_000));
      }

      // A line per suppressed tick is ~720/hour/position through an outage, and
      // it buries the one line that says what actually broke.
      const hits = warn.mock.calls.filter((c) => /backing off/.test(String(c[0])));
      expect(hits).toHaveLength(1);
      expect(String(hits[0][0])).toMatch(/1 consecutive; backing off 30s/);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not back off the agent for a database write failure', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.record.mockRejectedValueOnce(new Error('connection terminated'));
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    // The agent did its job; punishing it for a Postgres problem would back off
    // the wrong component and hide a healthy agent behind a broken write path.
    await t.svc.runForUser(USER, new Date(now.getTime() + 5_000));

    expect(t.judge).toHaveBeenCalledTimes(2);
  });

  it('backs off each position independently', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1'), watched('t2')]);
    t.judge.mockRejectedValueOnce(new Error('boom'));
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + 5_000));

    // t1 cooling down, t2 unaffected: 2 calls on the first run, 1 on the second.
    expect(t.judge).toHaveBeenCalledTimes(3);
    expect(t.record.mock.calls.every((c) => c[0].trackerId === 't2')).toBe(true);
  });
});

describe('SentinelCycleService — a rejected verdict is never a quiet outage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs the agent’s REASON at error, not just that something failed', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    // `judge` REJECTS a malformed verdict rather than recording it — a refusal,
    // an unparseable reply, evidence citing a field that is not in the packet.
    // No verdict row is written on any of those paths, so without a loud log a
    // prompt regression looks exactly like the sentinel going quiet: verdicts
    // simply stop appearing and nothing says why.
    t.judge.mockRejectedValue(
      new Error('verdict cited evidence not present in the packet: money.rsi'),
    );

    const report = await t.svc.runForUser(USER);

    expect(report.failed).toBe(1);
    expect(t.record).not.toHaveBeenCalled();
    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('money.rsi');
    // And which position it was about, or the line cannot be acted on.
    expect(logged).toContain('T1');
  });
});

/**
 * WHICH SYMBOL REACHES THE OI WALL CAPTURE.
 *
 * The fourth and worst of the four sites that passed the broker tradingsymbol
 * into a lookup keyed by the UNDERLYING. `OptionsChainService.getExpiries`
 * matches `optionChainSnapshot.underlying` exactly and
 * `instrument.symbol CONTAINS underlying`, so `NIFTY28AUG2524000CE` matches
 * neither and `walls()` returns `[]`.
 *
 * Worse than the other three because `wallsFor` early-returns without an
 * expiry — so it runs ONLY for derivatives, and the mistake therefore affected
 * 100% of the positions it was ever invoked for rather than a subset. And the
 * empty result is reported with an explicitly ambiguous cause ("cash stock, no
 * chain / fetch failed / service not wired"), so it read as a fact about the
 * instrument rather than as a bug.
 *
 * All four survived earlier review because nothing pinned the ARGUMENT.
 */
describe('SentinelCycleService — the OI capture is keyed by the underlying', () => {
  const OPTION = 'NIFTY28AUG2524000CE';

  const optionEntry = () => watched('t1', { symbol: OPTION });
  const optionTick = (over = {}) =>
    tick({
      segment: 'OPT',
      ltp: 120,
      underlyingLtp: 24000,
      expiry: '2026-08-27',
      structureSymbol: 'NIFTY',
      ...over,
    });

  it('captures under the UNDERLYING, never under the tradingsymbol', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([optionEntry()]);
    t.tickFor.mockResolvedValue(optionTick());

    await t.svc.runForUser(USER);

    expect(t.captureAndCompare).toHaveBeenCalledWith('NIFTY', '2026-08-27', 24000);
    expect(t.captureAndCompare).not.toHaveBeenCalledWith(
      OPTION,
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not capture at all when the underlying is unresolvable', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([optionEntry()]);
    t.tickFor.mockResolvedValue(optionTick({ structureSymbol: null }));

    await t.svc.runForUser(USER);

    // No fallback: the call would miss, and the miss is reported with an
    // ambiguous cause that reads as "this instrument has no chain".
    expect(t.captureAndCompare).not.toHaveBeenCalled();
  });

  it('still evaluates the position with the walls stated as absent', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([optionEntry()]);
    t.tickFor.mockResolvedValue(optionTick({ structureSymbol: null }));

    const report = await t.svc.runForUser(USER);

    // An unavailable OI chain must not cost the position its whole evaluation —
    // the packet reports the walls absent and the agent judges on the rest.
    expect(report.evaluated).toBe(1);
    expect(report.failed).toBe(0);
    const packetTick = t.buildPacket.mock.calls[0][1];
    expect(packetTick.oiWallNow).toBeNull();
    expect(packetTick.oiWallPrev).toBeNull();
    expect(packetTick.oiWallsAt).toBeNull();
  });

  it('still skips the capture entirely for a cash position', async () => {
    // The expiry guard, unchanged: cash has none, so nothing is captured
    // regardless of how good the symbol is.
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1', { symbol: 'SUZLON-EQ' })]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'EQ_INTRADAY', expiry: null, structureSymbol: 'SUZLON-EQ' }),
    );

    await t.svc.runForUser(USER);

    expect(t.captureAndCompare).not.toHaveBeenCalled();
  });
});
