import { decide, isExpired, mbmPacketRule, proposeTuning, type EvidenceRow, type RunSkill } from './proposals';
import { TUNABLES, type TunableValue } from '../tuning/tunables';
import type { SkillStats } from '../self-review.types';

const factorRows = (name: string, right: number, wrong: number, details: Record<string, unknown> = {}): EvidenceRow[] => [
  ...Array.from({ length: right }, (_, i) => ({ kind: 'SCORECARD_FACTOR', refId: `${name}-r${i}`, symbol: 'X', sessionDate: '2026-10-21', subject: name, correct: true, details })),
  ...Array.from({ length: wrong }, (_, i) => ({ kind: 'SCORECARD_FACTOR', refId: `${name}-w${i}`, symbol: 'X', sessionDate: '2026-10-20', subject: name, correct: false, details })),
];
const exitRows = (right: number, wrong: number, minutesSinceOpen: number | null = 60): EvidenceRow[] => [
  ...Array.from({ length: right }, (_, i) => ({ kind: 'LIVE_EXIT', refId: `e-r${i}`, symbol: 'X', sessionDate: '2026-10-21', subject: 'LONG', correct: true, details: { minutesSinceOpen } })),
  ...Array.from({ length: wrong }, (_, i) => ({ kind: 'LIVE_EXIT', refId: `e-w${i}`, symbol: 'X', sessionDate: '2026-10-21', subject: 'LONG', correct: false, details: { minutesSinceOpen } })),
];
const defaults = (over: Record<string, TunableValue> = {}) => (t: string): TunableValue => over[t] ?? (TUNABLES[t].default as TunableValue);

describe('proposeTuning (deterministic)', () => {
  it('weak factor (rolling-20 hit < 45 %, n ≥ 5) → weight × 0.5', () => {
    const { drafts } = proposeTuning({ rows: factorRows('news', 1, 5), current: defaults(), pendingKeys: new Set() });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ key: 'scorecard.factor.news.weight', target: 'scorecard.factor.news.weight', currentValue: 1, proposedValue: 0.5 });
    expect(drafts[0].evidence).toMatchObject({ n: 6, right: 1, wrong: 5 });
    expect(drafts[0].evidence.examples.length).toBeLessThanOrEqual(5);
  });

  it('too little evidence → nothing', () => {
    expect(proposeTuning({ rows: factorRows('news', 0, 4), current: defaults(), pendingKeys: new Set() }).drafts).toEqual([]);
  });

  it('strong factor (> 65 %, n ≥ 20) → weight × 1.25, bounded at 1.5', () => {
    expect(proposeTuning({ rows: factorRows('oi', 18, 2), current: defaults(), pendingKeys: new Set() }).drafts[0]).toMatchObject({ proposedValue: 1.25 });
    expect(proposeTuning({ rows: factorRows('oi', 18, 2), current: defaults({ 'scorecard.factor.oi.weight': 1.4 }), pendingKeys: new Set() }).drafts[0]).toMatchObject({ proposedValue: 1.5 });
    // already at the bound → no proposal
    expect(proposeTuning({ rows: factorRows('oi', 18, 2), current: defaults({ 'scorecard.factor.oi.weight': 1.5 }), pendingKeys: new Set() }).drafts).toEqual([]);
    // > 65 % but n < 20 → nothing
    expect(proposeTuning({ rows: factorRows('oi', 9, 1), current: defaults(), pendingKeys: new Set() }).drafts).toEqual([]);
  });

  it('a silenced factor (weight 0) can earn weight back', () => {
    expect(proposeTuning({ rows: factorRows('vix', 18, 2), current: defaults({ 'scorecard.factor.vix.weight': 0 }), pendingKeys: new Set() }).drafts[0]).toMatchObject({ proposedValue: 0.5 });
  });

  it('one PENDING per key', () => {
    const out = proposeTuning({ rows: factorRows('news', 1, 5), current: defaults(), pendingKeys: new Set(['scorecard.factor.news.weight']) });
    expect(out.drafts).toEqual([]);
    expect(out.rejected[0].reason).toMatch(/pending/);
  });

  it('unconfirmed positive news losing → requireConfirmation = true', () => {
    const rows = factorRows('news', 1, 5, { newsConfirmed: false, points: 1 });
    const t = proposeTuning({ rows, current: defaults(), pendingKeys: new Set() }).drafts.find((d) => d.target === 'scorecard.factor.news.requireConfirmation');
    expect(t).toMatchObject({ currentValue: false, proposedValue: true });
  });

  it('early exits losing → openingGuardMin + 5 (≤ 30); all exits losing → persistMinSec × 1.5 (≤ 600)', () => {
    const early = proposeTuning({ rows: exitRows(1, 5, 4), current: defaults({ 'exit.openingGuardMin': 28 }), pendingKeys: new Set() }).drafts;
    expect(early.find((d) => d.target === 'exit.openingGuardMin')).toMatchObject({ currentValue: 28, proposedValue: 30 });
    expect(early.find((d) => d.target === 'exit.persistMinSec')).toMatchObject({ currentValue: 120, proposedValue: 180 });
    const late = proposeTuning({ rows: exitRows(1, 5, 120), current: defaults({ 'exit.persistMinSec': 500 }), pendingKeys: new Set() }).drafts;
    expect(late.find((d) => d.target === 'exit.openingGuardMin')).toBeUndefined();
    expect(late.find((d) => d.target === 'exit.persistMinSec')).toMatchObject({ proposedValue: 600 });
  });

  describe('LLM suggestions: the code decides', () => {
    const rows = [...factorRows('mood', 3, 3)]; // 50 %: no rule fires
    it('accepts an allow-listed, in-bounds suggestion with ≥ 5 judged cases', () => {
      const out = proposeTuning({ rows, current: defaults(), pendingKeys: new Set(), suggestions: [{ proposalTarget: 'scorecard.factor.mood.weight', proposedValue: 0.8, cause: 'mood lags gaps' }] });
      expect(out.drafts[0]).toMatchObject({ target: 'scorecard.factor.mood.weight', proposedValue: 0.8 });
      expect(out.drafts[0].rationale).toMatch(/diagnosis/);
    });
    it.each([
      ['risk.maxDailyLoss', 1],
      ['killSwitch', true],
      ['exit.dailyExitCap', 3],
      ['autoExit.mode', 'live'],
      ['broker.apiKey', 'x'],
    ])('rejects %s', (target, value) => {
      const out = proposeTuning({ rows, current: defaults(), pendingKeys: new Set(), suggestions: [{ proposalTarget: target, proposedValue: value }] });
      expect(out.drafts).toEqual([]);
      expect(out.rejected).toEqual([{ target, reason: 'not allow-listed' }]);
    });
    it('rejects out-of-bounds values and thin evidence', () => {
      const oob = proposeTuning({ rows, current: defaults(), pendingKeys: new Set(), suggestions: [{ proposalTarget: 'scorecard.factor.mood.weight', proposedValue: 3 }] });
      expect(oob.drafts).toEqual([]);
      expect(oob.rejected[0].reason).toMatch(/outside/);
      const thin = proposeTuning({ rows: factorRows('mood', 1, 1), current: defaults(), pendingKeys: new Set(), suggestions: [{ proposalTarget: 'scorecard.factor.mood.weight', proposedValue: 0.8 }] });
      expect(thin.drafts).toEqual([]);
      expect(thin.rejected[0].reason).toMatch(/judged cases/);
    });
  });
});

describe('decide (apply / reject state machine)', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const p = { status: 'PENDING', target: 'scorecard.factor.oi.weight', proposedValue: 0.5 as unknown, createdAt: new Date('2026-10-20T12:00:00Z') };

  it('PENDING → APPROVED with the validated value; → REJECTED', () => {
    expect(decide(p, 'approve', now)).toEqual({ ok: true, status: 'APPROVED', value: 0.5 });
    expect(decide(p, 'reject', now)).toEqual({ ok: true, status: 'REJECTED' });
  });

  it.each(['APPROVED', 'APPLIED', 'REJECTED', 'EXPIRED'])('refuses a %s proposal', (status) => {
    expect(decide({ ...p, status }, 'approve', now).ok).toBe(false);
    expect(decide({ ...p, status }, 'reject', now).ok).toBe(false);
  });

  it('a PENDING older than 14 days is EXPIRED, not approvable', () => {
    const old = { ...p, createdAt: new Date('2026-10-01T00:00:00Z') };
    expect(isExpired(old, now)).toBe(true);
    expect(decide(old, 'approve', now)).toMatchObject({ ok: false, status: 'EXPIRED' });
  });

  it('re-validates the target and bounds at approval', () => {
    expect(decide({ ...p, target: 'risk.maxDailyLoss' }, 'approve', now).ok).toBe(false);
    expect(decide({ ...p, proposedValue: 2 }, 'approve', now).ok).toBe(false);
  });
});

describe('stock big-move points rule', () => {
  const rows = (bucket: string, big: number, small: number): EvidenceRow[] =>
    [...Array.from({ length: big }, () => true), ...Array.from({ length: small }, () => false)].map((outcomeBig, i) => ({
      kind: 'STOCK_MOVE', refId: `${bucket}-${i}`, symbol: `S${i}`, sessionDate: '2026-10-21', subject: bucket,
      correct: (bucket === 'TOP20') === outcomeBig, details: { bucket, outcomeBig },
    }));
  const target = 'scorecard.stockMove.points';
  const run = (r: EvidenceRow[], cur: Record<string, TunableValue> = {}) =>
    proposeTuning({ rows: r, current: defaults(cur), pendingKeys: new Set() }).drafts.filter((d) => d.target === target);

  it('≥ 20 judged, TOP20 big ≥ 60 %, BOTTOM20 big ≤ 35 % → propose 1', () => {
    const d = run([...rows('TOP20', 7, 3), ...rows('BOTTOM20', 3, 7)]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ currentValue: 0, proposedValue: 1, evidence: { n: 20, right: 14, wrong: 6 } });
    expect(d[0].rationale).toContain('TOP20 moved big 70% of 10');
  });
  it('below the bars, too few rows, or already on → nothing', () => {
    expect(run([...rows('TOP20', 5, 5), ...rows('BOTTOM20', 2, 8)])).toEqual([]); // TOP20 50 %
    expect(run([...rows('TOP20', 8, 2), ...rows('BOTTOM20', 4, 6)])).toEqual([]); // BOTTOM20 40 %
    expect(run([...rows('TOP20', 7, 2), ...rows('BOTTOM20', 2, 8)])).toEqual([]); // 19 judged
    expect(run([...rows('TOP20', 18, 2), ...rows('BOTTOM20', 1, 3)])).toEqual([]); // BOTTOM20 < 5 rows
    expect(run([...rows('TOP20', 7, 3), ...rows('BOTTOM20', 3, 7)], { [target]: 1 })).toEqual([]);
  });
  it('MID rows are not evidence, and a diagnosis suggestion cannot turn it on', () => {
    const mid: EvidenceRow[] = Array.from({ length: 30 }, (_, i) => ({ kind: 'STOCK_MOVE', refId: `m${i}`, symbol: 'X', sessionDate: '2026-10-21', subject: 'MID', correct: null, details: {} }));
    expect(run([...mid, ...rows('TOP20', 6, 4), ...rows('BOTTOM20', 3, 6)])).toEqual([]); // 19 judged
    const out = proposeTuning({ rows: [], current: defaults(), pendingKeys: new Set(), suggestions: [{ proposalTarget: target, proposedValue: 1 }] });
    expect(out.drafts).toEqual([]);
    expect(out.rejected[0]).toMatchObject({ target });
  });
});

describe('mbm.packet rule (rolling-20 skill verdict, 2 consecutive runs)', () => {
  const target = 'mbm.packet';
  const skill = (verdict: SkillStats['verdict']): SkillStats => ({
    n: 400, positives: 120, baseRate: 0.3, hitRate: 0.78, majorityHitRate: 0.7, auc: verdict === 'EDGE' ? 0.71 : 0.52,
    brier: 0.16, brierBaseline: 0.21, brierSkill: verdict === 'EDGE' ? 0.24 : -0.02, verdict, note: '',
  });
  const runs = (...v: Array<SkillStats['verdict']>): RunSkill[] => v.map((x, i) => ({ session: `2026-10-${22 - i}`, skill: skill(x) }));
  const run = (r: RunSkill[], cur: Record<string, TunableValue> = {}) =>
    proposeTuning({ rows: [], current: defaults(cur), pendingKeys: new Set(), mbmSkill: r }).drafts.filter((d) => d.target === target);

  it('EDGE twice while off → propose false → true with the skill numbers as evidence', () => {
    const d = run(runs('EDGE', 'EDGE'));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ key: target, currentValue: false, proposedValue: true, evidence: { n: 400, right: 312, wrong: 88 } });
    expect(d[0].rationale).toContain('2026-10-22: EDGE AUC 0.71, Brier skill 0.24, n 400; 2026-10-21: EDGE');
    expect(d[0].rationale).toContain('vs always-majority 70%');
  });

  it('NO_EDGE twice while on → propose true → false; NO_EDGE while off says nothing', () => {
    const d = run(runs('NO_EDGE', 'NO_EDGE'), { [target]: true });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ currentValue: true, proposedValue: false });
    expect(run(runs('NO_EDGE', 'NO_EDGE'))).toEqual([]);
    expect(run(runs('EDGE', 'EDGE'), { [target]: true })).toEqual([]);
  });

  it('NOT_TESTABLE never proposes; nor does one run, a mixed pair, or a pending key', () => {
    expect(run(runs('NOT_TESTABLE', 'NOT_TESTABLE'))).toEqual([]);
    expect(run(runs('NOT_TESTABLE', 'NOT_TESTABLE'), { [target]: true })).toEqual([]);
    expect(run(runs('EDGE', 'NOT_TESTABLE'))).toEqual([]);
    expect(run(runs('NOT_TESTABLE', 'EDGE'))).toEqual([]);
    expect(run(runs('NO_EDGE', 'NOT_TESTABLE'), { [target]: true })).toEqual([]);
    expect(run(runs('EDGE'))).toEqual([]);
    expect(run(runs('EDGE', 'NO_EDGE'))).toEqual([]);
    expect(run([])).toEqual([]);
    expect(mbmPacketRule(false, runs('NOT_TESTABLE', 'NOT_TESTABLE', 'EDGE'))).toBeNull();
    const pending = proposeTuning({ rows: [], current: defaults(), pendingKeys: new Set([target]), mbmSkill: runs('EDGE', 'EDGE') });
    expect(pending.drafts).toEqual([]);
    expect(pending.rejected).toContainEqual({ target, reason: 'a proposal for this key is already pending' });
  });

  it('a diagnosis suggestion cannot set it', () => {
    const out = proposeTuning({ rows: [], current: defaults(), pendingKeys: new Set(), suggestions: [{ proposalTarget: target, proposedValue: true }] });
    expect(out.drafts).toEqual([]);
    expect(out.rejected).toEqual([{ target, reason: 'mbm.packet is rule-only (not a diagnosis suggestion)' }]);
  });
});
