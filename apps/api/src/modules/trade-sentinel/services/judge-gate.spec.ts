import {
  ADVISORY_VERDICT,
  LIVE_GAP_FIRE,
  advisoryVerdict,
  capBypass,
  hardRiskWindow,
  isAdverseMove,
  exitTriggerCrossed,
  gateJudgement,
  liveGapDecision,
  liveLookOwed,
  parseJudgeGateConfig,
  type GateFacts,
} from './judge-gate';
import type { TripwireResult } from './tripwire.service';

const cfg = parseJudgeGateConfig({});
const NOW = Date.parse('2026-10-12T06:00:00.000Z');
const MIN = 60_000;
const fire = (...names: string[]): TripwireResult => ({
  fires: names.map((name) => ({ name, detail: name })), heartbeat: false, shouldEvaluate: true, trigger: 'FIRE',
});
const HEARTBEAT: TripwireResult = { fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' };
const NOT_DUE: TripwireResult = { fires: [], heartbeat: false, shouldEvaluate: false, trigger: null };
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  nowMs: NOW, last: { verdict: 'HOLD', createdAt: new Date(NOW - 5 * MIN) }, held: false, hardRisk: false,
  floorBreached: false, triggerCrossed: false, adverseMove: false, carried: new Set(), ...over,
});
const never = () => false;

describe('parseJudgeGateConfig', () => {
  it('defaults: on, 15-min cap, 60-min held heartbeat, 10-min live gap, close guard = GATE_CLOSE_MIN, delta on', () => {
    expect(cfg).toEqual({
      enabled: true, minIntervalMs: 900_000, heldHeartbeatMs: 60 * MIN, hold: [], closeGuardMin: 10,
      expiryCloseMin: 30, adverseMovePct: 0.04, adverseMoveNEq: 6, adverseMovePctEq: 0.008,
      eqSquareOffLeadMin: 15, packetDelta: true, squareOffLook: true, squareOffRelookMin: 5, greenToRed: true,
      liveMaxGapMs: 10 * MIN,
    });
  });
  it('reads overrides, the hold list like the executor, and the rollbacks', () => {
    const c = parseJudgeGateConfig({
      SENTINEL_JUDGE_GATE: 'false', SENTINEL_MIN_JUDGE_INTERVAL_SEC: '600', SENTINEL_HELD_HEARTBEAT_MIN: 'x',
      AI_AUTO_EXIT_HOLD: ' reliance27oct261270ce, t9 ', GATE_CLOSE_MIN: '15', SENTINEL_PACKET_DELTA: 'FALSE',
    });
    expect(c).toMatchObject({ enabled: false, minIntervalMs: 600_000, heldHeartbeatMs: 60 * MIN, hold: ['RELIANCE27OCT261270CE', 'T9'], closeGuardMin: 15, packetDelta: false });
  });
  it('SENTINEL_LIVE_MAX_GAP_MIN: a number of minutes; 0 turns the live-gap look off; junk keeps 10', () => {
    expect(parseJudgeGateConfig({ SENTINEL_LIVE_MAX_GAP_MIN: '7' }).liveMaxGapMs).toBe(7 * MIN);
    expect(parseJudgeGateConfig({ SENTINEL_LIVE_MAX_GAP_MIN: '0' }).liveMaxGapMs).toBe(0);
    expect(parseJudgeGateConfig({ SENTINEL_LIVE_MAX_GAP_MIN: 'x' }).liveMaxGapMs).toBe(10 * MIN);
    expect(parseJudgeGateConfig({ SENTINEL_HELD_HEARTBEAT_MIN: '45' }).heldHeartbeatMs).toBe(45 * MIN);
  });
});

describe('gateJudgement — the cap', () => {
  it('drops a wake inside the interval, carrying only edge-triggered and already-carried fires', () => {
    const r = gateJudgement(fire('giveback-off-peak', 'news-hit', 'oi-wall-shift'), facts({ carried: new Set(['oi-wall-shift']) }), cfg, never);
    expect(r.dropped).toBe('cap');
    expect(r.decision.shouldEvaluate).toBe(false);
    expect(r.suppressed).toEqual(['giveback-off-peak', 'news-hit', 'oi-wall-shift']);
    expect(r.carry.map((f) => f.name)).toEqual(['news-hit', 'oi-wall-shift']);
  });
  it('passes at the interval', () => {
    const r = gateJudgement(fire('giveback-off-peak'), facts({ last: { verdict: 'HOLD', createdAt: new Date(NOW - 15 * MIN) } }), cfg, never);
    expect(r.dropped).toBeNull();
    expect(r.decision.shouldEvaluate).toBe(true);
  });
  it.each([
    ['first-look', { last: null }],
    ['hard-risk', { hardRisk: true }],
    ['floor-breach', { floorBreached: true }],
    ['trigger-crossed', { triggerCrossed: true }],
    ['adverse-move', { adverseMove: true }],
    ['exit-candidate', { last: { verdict: 'EXIT_ARMED', createdAt: new Date(NOW - MIN) } }],
    ['exit-candidate', { last: { verdict: 'EXIT_NOW', createdAt: new Date(NOW - MIN) } }],
  ] as const)('bypass %s', (name, over) => {
    const r = gateJudgement(fire('giveback-off-peak'), facts(over as Partial<GateFacts>), cfg, never);
    expect(r.dropped).toBeNull();
    expect(r.bypass).toBe(name);
  });
  it('bypass exit-confirm (the exit-discipline confirmation re-look)', () => {
    expect(capBypass(fire('exit-confirm'), facts())).toBe('exit-confirm');
    expect(gateJudgement(fire('exit-confirm'), facts(), cfg, never).dropped).toBeNull();
  });
  it('off (or unbound) is a no-op', () => {
    const d = fire('giveback-off-peak');
    expect(gateJudgement(d, facts(), parseJudgeGateConfig({ SENTINEL_JUDGE_GATE: 'false' }), never).decision).toBe(d);
    expect(gateJudgement(d, facts(), undefined, never).decision).toBe(d);
  });
});

describe('gateJudgement — held', () => {
  const held = (msAgo: number) => facts({ held: true, last: { verdict: 'EXIT_NOW', createdAt: new Date(NOW - msAgo) } });
  it('drops every fire, new-risk ones included; the heartbeat is the clock alone, at most once per 60 min', () => {
    expect(gateJudgement(fire('news-hit', 'level-break'), held(40 * MIN), cfg, never)).toMatchObject({ dropped: 'held', suppressed: ['news-hit', 'level-break'] });
    expect(gateJudgement(fire('news-hit'), held(40 * MIN), cfg, never).decision.shouldEvaluate).toBe(false);
    // A fire never makes it due early, whatever the normal cadence says (prod 2026-11-27 MAZDOCK: 13 Opus EXIT_NOWs).
    expect(gateJudgement(fire('news-hit'), held(40 * MIN), cfg, () => true).decision.shouldEvaluate).toBe(false);
    expect(gateJudgement(HEARTBEAT, held(30 * MIN), cfg, () => true)).toMatchObject({ dropped: 'held', suppressed: ['heartbeat'] });
    expect(gateJudgement(HEARTBEAT, held(59 * MIN), cfg, never).decision.shouldEvaluate).toBe(false);
    expect(gateJudgement(HEARTBEAT, held(60 * MIN), cfg, never).decision).toEqual(HEARTBEAT);
    // At 60 min the look is owed even on a pass whose tripwire said nothing (no material move) or only fired.
    expect(gateJudgement(NOT_DUE, held(60 * MIN), cfg, never).decision).toEqual(HEARTBEAT);
    expect(gateJudgement(fire('giveback-off-peak', 'exit-confirm'), held(61 * MIN), cfg, never)).toMatchObject({
      decision: HEARTBEAT, dropped: 'held', suppressed: ['giveback-off-peak', 'exit-confirm'],
    });
    // First sight of a held position: one look.
    expect(gateJudgement(NOT_DUE, facts({ held: true, last: null }), cfg, never).decision).toEqual(HEARTBEAT);
  });
  it('is never upgraded to the strong tier and never bypasses', () => {
    const r = gateJudgement(HEARTBEAT, held(61 * MIN), cfg, never);
    expect(r.decision.trigger).toBe('HEARTBEAT');
    expect(r.upgraded).toBe(false);
  });
});

describe('liveLookOwed — a live position is looked at at least every SENTINEL_LIVE_MAX_GAP_MIN', () => {
  const base = { cfg, held: false, paper: false, segment: 'OPT' as const, venueOpen: true, nowMs: NOW };
  it('owed at 10 min since the agent last looked, not before', () => {
    expect(liveLookOwed({ ...base, lastAgentMs: NOW - 9 * MIN })).toBe(false);
    expect(liveLookOwed({ ...base, lastAgentMs: NOW - 10 * MIN })).toBe(true);
    // Prod 2026-11-27 CRUDEOIL16DEC268350CE: 15:40:32 → 15:59:45 (1152 s) with no look.
    expect(liveLookOwed({ ...base, lastAgentMs: NOW - 1152_000 })).toBe(true);
    expect(liveLookOwed({ ...base, lastAgentMs: null })).toBe(true);
  });
  it.each([
    ['held (AI_AUTO_EXIT_HOLD)', { held: true }],
    ['paper', { paper: true }],
    ['the venue is closed', { venueOpen: false }],
    ['a delivery holding', { segment: 'EQ_DELIVERY' as const }],
    ['turned off (0)', { cfg: parseJudgeGateConfig({ SENTINEL_LIVE_MAX_GAP_MIN: '0' }) }],
    ['the gate off', { cfg: parseJudgeGateConfig({ SENTINEL_JUDGE_GATE: 'false' }) }],
    ['no gate config', { cfg: undefined }],
  ])('never when %s', (_n, over) => {
    expect(liveLookOwed({ ...base, lastAgentMs: NOW - 30 * MIN, ...(over as object) })).toBe(false);
  });
  it('the look is a routine (HEARTBEAT-tier) wake named live-gap', () => {
    const d = liveGapDecision(NOW - 19 * MIN, NOW);
    expect(d).toMatchObject({ heartbeat: false, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    expect(d.fires).toEqual([{ name: LIVE_GAP_FIRE, detail: expect.stringMatching(/19 min/) }]);
    expect(liveGapDecision(null, NOW).fires[0].detail).toMatch(/never/);
  });
});

describe('advisory verdicts — an EXIT_NOW that must never reach the executor', () => {
  it('EXIT_NOW becomes EXIT_ADVISORY with the reason tagged; every other verdict is unchanged', () => {
    expect(advisoryVerdict('EXIT_NOW', 'sell it', 'owner hold')).toEqual({ verdict: ADVISORY_VERDICT, reason: '[advisory: owner hold] sell it' });
    expect(ADVISORY_VERDICT).not.toBe('EXIT_NOW');
    for (const v of ['HOLD', 'EXIT_ARMED', 'ESCALATE']) expect(advisoryVerdict(v, 'r', 'owner hold')).toEqual({ verdict: v, reason: 'r' });
  });
});

describe('gateJudgement — tier', () => {
  const old = (verdict: string) => facts({ last: { verdict, createdAt: new Date(NOW - 20 * MIN) } });
  it('a routine wake stays routine after a HOLD', () => {
    expect(gateJudgement(HEARTBEAT, old('HOLD'), cfg, never).decision.trigger).toBe('HEARTBEAT');
  });
  it.each([
    ['an EXIT_ARMED', old('EXIT_ARMED')],
    ['an EXIT_NOW', old('EXIT_NOW')],
    ['hard risk', { ...old('HOLD'), hardRisk: true }],
    ['a floor breach', { ...old('HOLD'), floorBreached: true }],
  ])('a routine wake after %s goes to the strong tier', (_n, f) => {
    const r = gateJudgement(HEARTBEAT, f, cfg, never);
    expect(r.decision.trigger).toBe('FIRE');
    expect(r.upgraded).toBe(true);
  });
});

describe('exitTriggerCrossed', () => {
  it('reads both instruments and both directions; anything odd is not crossed', () => {
    const px = { ltp: 99, underlyingLtp: 25000 };
    expect(exitTriggerCrossed({ v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 100 }, px)).toBe(true);
    expect(exitTriggerCrossed({ v: 1, instrument: 'PREMIUM', op: 'ABOVE', price: 100 }, px)).toBe(false);
    expect(exitTriggerCrossed({ v: 1, instrument: 'UNDERLYING', op: 'ABOVE', price: 24900 }, px)).toBe(true);
    expect(exitTriggerCrossed({ v: 1, instrument: 'UNDERLYING', op: 'BELOW', price: 24900 }, { ltp: 99, underlyingLtp: null })).toBe(false);
    expect(exitTriggerCrossed({ v: 1, problem: 'malformed' }, px)).toBe(false);
    expect(exitTriggerCrossed(null, px)).toBe(false);
  });
});

describe('isAdverseMove — cash equity is far less volatile than a premium', () => {
  const mv = (segment: any, ltp: number, noiseN: number | null = null, dir: 1 | -1 = 1) =>
    isAdverseMove(cfg, { segment, prevLtp: 100, ltp, dir, noiseN });

  it('F&O keeps the 4 % rule exactly, and ignores any noise unit', () => {
    expect([mv('OPT', 96), mv('OPT', 96.1), mv('FUT', 96), mv(undefined, 96)]).toEqual([true, false, true, true]);
    expect(mv('OPT', 99, 0.1)).toBe(false); // 10 N, but only 1 %
    expect(mv('OPT', 104, null, -1)).toBe(true); // a short, price up 4 %
  });

  it('cash with a noise unit: 6 N against the position', () => {
    expect(mv('EQ_INTRADAY', 99.4, 0.1)).toBe(true);
    expect(mv('EQ_INTRADAY', 99.5, 0.1)).toBe(false);
    expect(mv('EQ_INTRADAY', 100.6, 0.1, -1)).toBe(true);
    expect(mv('EQ_INTRADAY', 100.6, 0.1)).toBe(false); // favourable
  });

  it('cash without a noise unit: the 0.8 % fallback', () => {
    expect([mv('EQ_INTRADAY', 99.2), mv('EQ_INTRADAY', 99.3), mv('EQ_DELIVERY', 99.2, 0)]).toEqual([true, false, true]);
  });

  it('no usable last price is never adverse', () => {
    expect(isAdverseMove(cfg, { segment: 'OPT', prevLtp: 0, ltp: 1, dir: 1, noiseN: null })).toBe(false);
  });

  it('env overrides touch only the equity rule', () => {
    const c = parseJudgeGateConfig({ SENTINEL_ADVERSE_MOVE_N_EQ: '4', SENTINEL_ADVERSE_MOVE_PCT_EQ: '0.012', SENTINEL_ADVERSE_MOVE_PCT: '0.06' });
    expect(isAdverseMove(c, { segment: 'EQ_INTRADAY', prevLtp: 100, ltp: 99.6, dir: 1, noiseN: 0.1 })).toBe(true);
    expect(isAdverseMove(c, { segment: 'EQ_INTRADAY', prevLtp: 100, ltp: 98.9, dir: 1, noiseN: null })).toBe(false);
    expect(isAdverseMove(c, { segment: 'OPT', prevLtp: 100, ltp: 95, dir: 1, noiseN: null })).toBe(false);
    expect(parseJudgeGateConfig({ SENTINEL_ADVERSE_MOVE_N_EQ: '-1' }).adverseMoveNEq).toBe(6);
  });
});

describe('hardRiskWindow — intraday cash counts to the 15:15 MIS square-off', () => {
  it('F&O: unchanged — 10 min to the close, 30 on expiry day', () => {
    expect([hardRiskWindow(cfg, 'OPT', 11, false), hardRiskWindow(cfg, 'OPT', 10, false)]).toEqual([false, true]);
    expect([hardRiskWindow(cfg, 'FUT', 30, true), hardRiskWindow(cfg, 'FUT', 31, true)]).toEqual([true, false]);
    expect(hardRiskWindow(cfg, undefined, 10, false)).toBe(true);
  });

  it('EQ_INTRADAY opens at 15:05 (25 min to the 15:30 close) and stays open past the square-off', () => {
    expect(hardRiskWindow(cfg, 'EQ_INTRADAY', 26, false)).toBe(false);
    expect(hardRiskWindow(cfg, 'EQ_INTRADAY', 25, false)).toBe(true);
    expect(hardRiskWindow(cfg, 'EQ_INTRADAY', 5, false)).toBe(true);
    expect(hardRiskWindow(parseJudgeGateConfig({ SENTINEL_EQ_SQUARE_OFF_LEAD_MIN: '10' }), 'EQ_INTRADAY', 21, false)).toBe(false);
  });

  it('delivery and a closed session are never in it', () => {
    expect([hardRiskWindow(cfg, 'EQ_DELIVERY', 1, false), hardRiskWindow(cfg, 'OPT', null, true)]).toEqual([false, false]);
  });
});

describe('gateJudgement — the 2026-10-29 bypasses (square-off due, green-to-red)', () => {
  it('a square-off-due fire is never capped, and is named', () => {
    const r = gateJudgement(fire('square-off-due'), facts(), cfg, never);
    expect(r.dropped).toBeNull();
    expect(r.bypass).toBe('square-off-due');
  });

  it('green-to-red owed: the capped giveback passes once (prod CRUDEOIL 2026-10-29)', () => {
    const owed = gateJudgement(fire('giveback-off-peak', 'news-hit'), facts({ greenToRed: true, greenToRedOwed: true }), cfg, never);
    expect(owed.dropped).toBeNull();
    expect(owed.bypass).toBe('green-to-red');
    // Spent (judged on it already this peak): the cap is back.
    const spent = gateJudgement(fire('giveback-off-peak'), facts({ greenToRed: true, greenToRedOwed: false }), cfg, never);
    expect(spent.dropped).toBe('cap');
  });

  it('green-to-red owed raises a routine heartbeat to the strong tier', () => {
    const r = gateJudgement(HEARTBEAT, facts({ greenToRed: true, greenToRedOwed: true }), cfg, never);
    expect(r.decision.trigger).toBe('FIRE');
    expect(r.upgraded).toBe(true);
  });

  it('giveback-green: only a giveback-off-peak fire on a net-green peak, once', () => {
    expect(gateJudgement(fire('giveback-off-peak'), facts({ givebackGreenOwed: true }), cfg, never).bypass).toBe('giveback-green');
    expect(gateJudgement(fire('volume-anomaly'), facts({ givebackGreenOwed: true }), cfg, never).dropped).toBe('cap');
    expect(gateJudgement(fire('giveback-off-peak'), facts({ givebackGreenOwed: false }), cfg, never).dropped).toBe('cap');
  });

  it('absent facts (older callers) change nothing; the switches parse', () => {
    expect(gateJudgement(fire('giveback-off-peak'), facts(), cfg, never).dropped).toBe('cap');
    const off = parseJudgeGateConfig({ SENTINEL_SQUARE_OFF_LOOK: 'false', SENTINEL_GREEN_TO_RED_BYPASS: 'false', SENTINEL_SQUARE_OFF_RELOOK_MIN: '0' });
    expect(off).toMatchObject({ squareOffLook: false, greenToRed: false, squareOffRelookMin: 0 });
  });
});
