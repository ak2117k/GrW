import { capBypass, exitTriggerCrossed, gateJudgement, parseJudgeGateConfig, type GateFacts } from './judge-gate';
import type { TripwireResult } from './tripwire.service';

const cfg = parseJudgeGateConfig({});
const NOW = Date.parse('2026-10-12T06:00:00.000Z');
const MIN = 60_000;
const fire = (...names: string[]): TripwireResult => ({
  fires: names.map((name) => ({ name, detail: name })), heartbeat: false, shouldEvaluate: true, trigger: 'FIRE',
});
const HEARTBEAT: TripwireResult = { fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' };
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  nowMs: NOW, last: { verdict: 'HOLD', createdAt: new Date(NOW - 5 * MIN) }, held: false, hardRisk: false,
  floorBreached: false, triggerCrossed: false, adverseMove: false, carried: new Set(), ...over,
});
const never = () => false;

describe('parseJudgeGateConfig', () => {
  it('defaults: on, 15-min cap, 30-min held heartbeat, close guard = GATE_CLOSE_MIN, delta on', () => {
    expect(cfg).toEqual({
      enabled: true, minIntervalMs: 900_000, heldHeartbeatMs: 30 * MIN, hold: [], closeGuardMin: 10,
      expiryCloseMin: 30, adverseMovePct: 0.04, packetDelta: true,
    });
  });
  it('reads overrides, the hold list like the executor, and the rollbacks', () => {
    const c = parseJudgeGateConfig({
      SENTINEL_JUDGE_GATE: 'false', SENTINEL_MIN_JUDGE_INTERVAL_SEC: '600', SENTINEL_HELD_HEARTBEAT_MIN: 'x',
      AI_AUTO_EXIT_HOLD: ' reliance27oct261270ce, t9 ', GATE_CLOSE_MIN: '15', SENTINEL_PACKET_DELTA: 'FALSE',
    });
    expect(c).toMatchObject({ enabled: false, minIntervalMs: 600_000, heldHeartbeatMs: 30 * MIN, hold: ['RELIANCE27OCT261270CE', 'T9'], closeGuardMin: 15, packetDelta: false });
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
  it('drops every fire, new-risk ones included; a due heartbeat waits for 30 min', () => {
    expect(gateJudgement(fire('news-hit', 'level-break'), held(40 * MIN), cfg, never)).toMatchObject({ dropped: 'held', suppressed: ['news-hit', 'level-break'] });
    expect(gateJudgement(fire('news-hit'), held(40 * MIN), cfg, never).decision.shouldEvaluate).toBe(false);
    // The fire's tick skipped the heartbeat computation: heartbeatDue answers it.
    expect(gateJudgement(fire('news-hit'), held(40 * MIN), cfg, () => true).decision).toEqual(HEARTBEAT);
    expect(gateJudgement(HEARTBEAT, held(20 * MIN), cfg, never)).toMatchObject({ dropped: 'held', suppressed: ['heartbeat'] });
    expect(gateJudgement(HEARTBEAT, held(30 * MIN), cfg, never).decision).toEqual(HEARTBEAT);
  });
  it('is never upgraded to the strong tier and never bypasses', () => {
    const r = gateJudgement(HEARTBEAT, held(31 * MIN), cfg, never);
    expect(r.decision.trigger).toBe('HEARTBEAT');
    expect(r.upgraded).toBe(false);
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
