/**
 * The deterministic proposal engine (contract "Proposals"). The LLM diagnosis may SUGGEST a target
 * and value; this code decides: allow-listed target, value inside the hard bounds, evidence that passes
 * {@link evidenceGate} (≥ 5 independent judged cases from ≥ 10 sessions, not a coin flip) over the rolling window (only from sessions after the key's last APPLIED decision, or
 * its last REJECTED one in the same direction), one PENDING per key. Anything else is rejected with a reason.
 */
import type { ProposalDraft, ProposalEvidence, ProposalStatus, SkillStats } from '../self-review.types';
import { DIRECTION_FREE_FACTORS, INDEX_ONLY_DIRECTION_FACTORS, MIN_JUDGED_MOVE_BP } from './scorers';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import {
  clampTunable,
  isAllowedTarget,
  MBM_PACKET_TARGET,
  NEWS_CONFIRMATION_TARGET,
  OPENING_GUARD_TARGET,
  PERSIST_MIN_TARGET,
  SCORECARD_WEIGHT_FACTORS,
  STOCK_MOVE_POINTS_TARGET,
  validateTunable,
  weightTarget,
  type TunableValue,
} from '../tuning/tunables';

export const MIN_EVIDENCE = 5;
export const STRONG_EVIDENCE = 20;
export const LOW_HIT = 0.45;
export const HIGH_HIT = 0.65;
export const PENDING_TTL_DAYS = 14;
/** Exits this early in the session are the opening-guard's evidence. */
export const EARLY_EXIT_MIN = 30;

export interface EvidenceRow {
  kind: string;
  refId: string;
  symbol: string | null;
  sessionDate: string;
  subject: string | null;
  correct: boolean | null;
  details: unknown;
}

export interface Suggestion {
  proposalTarget?: string | null;
  proposedValue?: unknown;
  cause?: string | null;
}

export interface EngineInput {
  /** Results of the rolling window (last 20 closed sessions), any kinds. */
  rows: readonly EvidenceRow[];
  /** The value in force now for a target (override, else the consumer's default). */
  current: (target: string) => TunableValue;
  /** Keys that already have a PENDING proposal. */
  pendingKeys: ReadonlySet<string>;
  suggestions?: readonly Suggestion[];
  /** MBM rolling-20 skill of this run and the previous runs, newest first (the `mbm.packet` rule). */
  mbmSkill?: readonly RunSkill[];
  /**
   * Past owner decisions (APPLIED proposals / overrides, REJECTED proposals). Evidence from sessions on
   * or before a decision is stale for that key: see {@link evidenceCutoff}.
   */
  decisions?: readonly PastDecision[];
}

/** An owner decision on a key; `session` is the IST date it was made, `direction` from {@link directionOf}. */
export interface PastDecision {
  key: string;
  status: 'APPLIED' | 'REJECTED';
  session: string;
  direction?: string | null;
}

/** 'up' / 'down' for a numeric change, the target value for a boolean; null when nothing moves. */
export function directionOf(from: unknown, to: unknown): string | null {
  if (typeof from === 'number' && typeof to === 'number') return to > from ? 'up' : to < from ? 'down' : null;
  if (typeof to === 'boolean') return from === to ? null : String(to);
  return null;
}

/**
 * The newest session whose evidence is stale for `key` (rows must be strictly AFTER it), or null.
 * An APPLIED change resets the key's evidence whatever the direction: the old rows were judged under
 * the old value (and a factor's hit rate is judged on its raw vote, so a weight change cannot move it),
 * so without this the same rule fires again every night on the same cases. A REJECTED proposal cools
 * down only the same direction: the owner said no to that move on that evidence.
 */
export function evidenceCutoff(key: string, decisions: readonly PastDecision[], direction: string | null): string | null {
  let cut: string | null = null;
  for (const d of decisions) {
    if (d.key !== key) continue;
    if (d.status === 'REJECTED' && (direction === null || d.direction !== direction)) continue;
    if (cut === null || d.session > cut) cut = d.session;
  }
  return cut;
}

const after = <T extends { sessionDate: string }>(rows: readonly T[], cut: string | null): readonly T[] =>
  cut === null ? rows : rows.filter((r) => r.sessionDate > cut);

export interface EngineOutput {
  drafts: ProposalDraft[];
  rejected: Array<{ target: string; reason: string }>;
}

const det = (r: EvidenceRow): Record<string, unknown> =>
  r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? (r.details as Record<string, unknown>) : {};

function evidenceOf(rows: readonly EvidenceRow[]): ProposalEvidence & { hitRate: number | null } {
  const judged = rows.filter((r) => r.correct !== null);
  const right = judged.filter((r) => r.correct === true).length;
  const wrong = judged.length - right;
  const examples = judged
    .filter((r) => r.correct === false)
    .slice(0, 5)
    .map((r) => ({ refId: r.refId, symbol: r.symbol, sessionDate: r.sessionDate }));
  const sessions = new Set(judged.map((r) => r.sessionDate)).size;
  return { n: judged.length, right, wrong, sessions, examples, hitRate: judged.length ? right / judged.length : null };
}

/**
 * A rule may move a tunable only on evidence that is not luck (2026-10-28: three proposals rested on 4–5
 * sessions, one RELIANCE contract counted 10 times): ≥ MIN_SESSIONS separate sessions and an exact
 * two-sided binomial test against a coin flip below SIGNIFICANCE.
 */
export const MIN_SESSIONS = 10;
export const SIGNIFICANCE = 0.05;

/** Two-sided exact binomial p-value of `k` successes in `n` trials at p = 0.5. */
export function binomialP(k: number, n: number): number {
  if (n <= 0) return 1;
  const pmf: number[] = [];
  let p = Math.pow(0.5, n);
  for (let i = 0; i <= n; i++) {
    pmf.push(p);
    p = (p * (n - i)) / (i + 1);
  }
  const at = pmf[k];
  const total = pmf.reduce((s, x) => (x <= at * (1 + 1e-9) ? s + x : s), 0);
  return Math.min(1, total);
}

/** Why `ev` cannot move a tunable, or null when it can. */
export function evidenceGate(ev: { n: number; right: number; sessions?: number }): string | null {
  if (ev.n < MIN_EVIDENCE) return `only ${ev.n} judged cases (need ${MIN_EVIDENCE})`;
  if ((ev.sessions ?? 0) < MIN_SESSIONS) return `only ${ev.sessions ?? 0} sessions of evidence (need ${MIN_SESSIONS})`;
  const p = binomialP(ev.right, ev.n);
  if (p >= SIGNIFICANCE) return `${ev.right}/${ev.n} is not distinguishable from a coin flip (p ${p.toFixed(2)})`;
  return null;
}

/** Factors whose reading is one market-wide value per session: one vote per session, not per symbol. */
export const MARKET_WIDE_FACTORS: ReadonlySet<string> = new Set(['fii_dii', 'vix']);

/**
 * Scorecard factor rows as independent evidence: rows the scorer would not judge today dropped (old rows
 * predate the direction-free / small-move rules), then one vote per (symbol, session) — the overnight and
 * pre-open windows score the same call twice — or per session for a market-wide factor. A collapsed
 * vote is its rows' majority; a tie is not judged.
 */
export function independentFactorRows(rows: readonly EvidenceRow[]): EvidenceRow[] {
  const groups = new Map<string, EvidenceRow[]>();
  for (const r of rows) {
    if (r.correct === null) continue;
    const d = det(r);
    const move = typeof d.moveBp === 'number' ? d.moveBp : NaN;
    if (r.subject && DIRECTION_FREE_FACTORS.has(r.subject)) continue;
    if (r.subject && INDEX_ONLY_DIRECTION_FACTORS.has(r.subject) && !(typeof d.underlying === 'string' && d.underlying in INDEX_UNDERLYINGS)) continue;
    if (Number.isFinite(move) && Math.abs(move) < MIN_JUDGED_MOVE_BP) continue;
    const k = r.subject && MARKET_WIDE_FACTORS.has(r.subject) ? `${r.subject}|${r.sessionDate}` : `${r.subject}|${r.symbol ?? r.refId}|${r.sessionDate}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.values()].map((g) => {
    const right = g.filter((r) => r.correct === true).length;
    const wrong = g.length - right;
    return g.length === 1 ? g[0] : { ...g[0], correct: right === wrong ? null : right > wrong };
  });
}

/** The rows that are evidence for `target` (also used to vet an LLM suggestion). */
export function evidenceRowsFor(target: string, rows: readonly EvidenceRow[]): EvidenceRow[] {
  for (const f of SCORECARD_WEIGHT_FACTORS) {
    if (target === weightTarget(f)) return independentFactorRows(rows.filter((r) => r.kind === 'SCORECARD_FACTOR' && r.subject === f));
  }
  if (target === NEWS_CONFIRMATION_TARGET) {
    return independentFactorRows(rows.filter((r) => r.kind === 'SCORECARD_FACTOR' && r.subject === 'news' && det(r).newsConfirmed === false));
  }
  if (target === OPENING_GUARD_TARGET) {
    return rows.filter((r) => {
      const m = det(r).minutesSinceOpen;
      return r.kind === 'LIVE_EXIT' && typeof m === 'number' && m >= 0 && m < EARLY_EXIT_MIN;
    });
  }
  if (target === PERSIST_MIN_TARGET) return rows.filter((r) => r.kind === 'LIVE_EXIT');
  if (target === STOCK_MOVE_POINTS_TARGET) return rows.filter((r) => r.kind === 'STOCK_MOVE');
  return [];
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

/** The rule-based value for `target` given its evidence, or null when the rules say nothing. */
function ruleValue(target: string, cur: TunableValue, ev: { n: number; right: number; sessions?: number; hitRate: number | null }): { value: TunableValue; why: string } | null {
  if (ev.hitRate === null || evidenceGate(ev)) return null;
  const low = ev.hitRate < LOW_HIT;
  const high = ev.hitRate > HIGH_HIT && ev.n >= STRONG_EVIDENCE;
  if (!low && !high) return null;
  if (target === NEWS_CONFIRMATION_TARGET) {
    if (low && cur === false) return { value: true, why: `unconfirmed positive news votes hit ${pct(ev.hitRate)} over ${ev.n} judged cases` };
    if (high && cur === true) return { value: false, why: `unconfirmed positive news votes would have hit ${pct(ev.hitRate)} over ${ev.n} cases` };
    return null;
  }
  if (typeof cur !== 'number') return null;
  if (target.startsWith('scorecard.factor.')) {
    const v = clampTunable(target, low ? cur * 0.5 : (cur === 0 ? 0.5 : cur * 1.25));
    return { value: v, why: `rolling-20 hit rate ${pct(ev.hitRate)} over ${ev.n} judged cases in ${ev.sessions} sessions (p ${binomialP(ev.right, ev.n).toFixed(3)}) → weight ×${low ? '0.5' : '1.25'}` };
  }
  if (target === OPENING_GUARD_TARGET) {
    return { value: clampTunable(target, low ? cur + 5 : cur - 5), why: `exits in the first ${EARLY_EXIT_MIN} min hit ${pct(ev.hitRate)} over ${ev.n} cases` };
  }
  if (target === PERSIST_MIN_TARGET) {
    return { value: clampTunable(target, low ? cur * 1.5 : cur * 0.75), why: `live exits hit ${pct(ev.hitRate)} over ${ev.n} cases` };
  }
  return null;
}

/** Stock big-move points (2026-10-22 stock-move contract): judged rows needed, and the bucket bars. */
export const STOCK_MOVE_MIN_JUDGED = 20;
export const STOCK_MOVE_TOP_MIN = 0.6;
export const STOCK_MOVE_BOTTOM_MAX = 0.35;

/**
 * `scorecard.stockMove.points` 0 → 1 once the shadow model has proved itself over the rolling window:
 * ≥ 20 judged STOCK_MOVE rows, TOP20 names moved big ≥ 60 % of the time and BOTTOM20 names ≤ 35 %
 * (each bucket with ≥ MIN_EVIDENCE judged rows). Only ever proposes turning it ON; the owner approves.
 */
export function stockMoveRule(cur: TunableValue, rows: readonly EvidenceRow[]): { value: TunableValue; why: string } | null {
  if (cur === 1) return null;
  const judged = rows.filter((r) => r.kind === 'STOCK_MOVE' && r.correct !== null);
  if (judged.length < STOCK_MOVE_MIN_JUDGED) return null;
  const bigRate = (bucket: string) => {
    const b = judged.filter((r) => r.subject === bucket);
    return b.length >= MIN_EVIDENCE ? { n: b.length, rate: b.filter((r) => det(r).outcomeBig === true).length / b.length } : null;
  };
  const top = bigRate('TOP20');
  const bottom = bigRate('BOTTOM20');
  if (!top || !bottom || top.rate < STOCK_MOVE_TOP_MIN || bottom.rate > STOCK_MOVE_BOTTOM_MAX) return null;
  return {
    value: 1,
    why:
      `stock big-move model: TOP20 moved big ${pct(top.rate)} of ${top.n}, BOTTOM20 ${pct(bottom.rate)} of ${bottom.n} ` +
      `(${judged.length} judged) → count it (+1 TOP20 / −1 BOTTOM20 for long options)`,
  };
}

/** The rolling-20 MBM skill of one self-review run (its summary's `skill.MBM_PREDICTION.rolling20`). */
export interface RunSkill {
  session: string;
  skill: SkillStats;
}

/** Consecutive runs whose rolling-20 verdict must agree before `mbm.packet` is proposed. */
export const MBM_PACKET_RUNS = 2;

/**
 * `mbm.packet` from the MBM move-size model's skill (domain/skill.ts), newest run first: EDGE in the last
 * two runs while off → propose on; NO_EDGE in the last two while on → propose off. NOT_TESTABLE (or a
 * mix, or fewer than two runs) proposes nothing. The owner approves in the app; this never applies.
 */
export function mbmPacketRule(cur: TunableValue, runs: readonly RunSkill[]): { value: TunableValue; why: string; ev: ProposalEvidence } | null {
  if (runs.length < MBM_PACKET_RUNS) return null;
  const last = runs.slice(0, MBM_PACKET_RUNS);
  const all = (v: SkillStats['verdict']) => last.every((r) => r.skill.verdict === v);
  let value: boolean;
  if (cur !== true && all('EDGE')) value = true;
  else if (cur === true && all('NO_EDGE')) value = false;
  else return null;
  const s = last[0].skill;
  const fmt = (x: number | null) => (x === null ? '—' : x.toFixed(2));
  const per = last.map((r) => `${r.session}: ${r.skill.verdict} AUC ${fmt(r.skill.auc)}, Brier skill ${fmt(r.skill.brierSkill)}, n ${r.skill.n}`).join('; ');
  const right = s.hitRate === null ? 0 : Math.round(s.hitRate * s.n);
  return {
    value,
    why:
      `MBM move-size model rolling-20 skill ${value ? 'EDGE' : 'NO_EDGE'} in ${MBM_PACKET_RUNS} consecutive runs (${per}; ` +
      `base rate ${pct(s.baseRate)}, hit ${pct(s.hitRate)} vs always-majority ${pct(s.majorityHitRate)}) → ` +
      (value ? 'feed it to the sentinel packet' : 'take it out of the sentinel packet'),
    ev: { n: s.n, right, wrong: s.n - right, examples: [] },
  };
}

export const RULE_TARGETS: readonly string[] = [
  ...SCORECARD_WEIGHT_FACTORS.map(weightTarget),
  NEWS_CONFIRMATION_TARGET,
  OPENING_GUARD_TARGET,
  PERSIST_MIN_TARGET,
  STOCK_MOVE_POINTS_TARGET,
];

export function proposeTuning(input: EngineInput): EngineOutput {
  const drafts: ProposalDraft[] = [];
  const rejected: EngineOutput['rejected'] = [];
  const taken = new Set<string>();
  const add = (target: string, value: TunableValue, why: string, ev: ProposalEvidence) => {
    const cur = input.current(target);
    if (value === cur) return;
    const v = validateTunable(target, value);
    if (!v.ok) return void rejected.push({ target, reason: v.reason });
    if (input.pendingKeys.has(target)) return void rejected.push({ target, reason: 'a proposal for this key is already pending' });
    taken.add(target);
    drafts.push({
      key: target,
      target,
      currentValue: cur,
      proposedValue: v.value,
      rationale: why,
      evidence: { n: ev.n, right: ev.right, wrong: ev.wrong, sessions: ev.sessions, examples: ev.examples },
    });
  };

  const decisions = input.decisions ?? [];
  /**
   * Run `rule` on the evidence after the key's cutoff. The cutoff depends on the direction of the
   * result (a REJECTED cool-down is per direction), so re-run on the stricter window until it settles.
   */
  const fresh = <R extends { value: TunableValue }>(target: string, rule: (cut: string | null) => R | null): R | null => {
    const cur = input.current(target);
    let cut = evidenceCutoff(target, decisions, null);
    for (let i = 0; i < 3; i++) {
      const r = rule(cut);
      if (!r) return null;
      const next = evidenceCutoff(target, decisions, directionOf(cur, r.value));
      if (next === cut) return r;
      cut = next;
    }
    return null;
  };

  for (const target of RULE_TARGETS) {
    let ev = evidenceOf([]);
    const r = fresh(target, (cut) => {
      const rows = after(input.rows, cut);
      ev = evidenceOf(evidenceRowsFor(target, rows));
      return target === STOCK_MOVE_POINTS_TARGET ? stockMoveRule(input.current(target), rows) : ruleValue(target, input.current(target), ev);
    });
    if (r) add(target, r.value, r.why, ev);
  }
  const mbm = fresh(MBM_PACKET_TARGET, (cut) =>
    mbmPacketRule(input.current(MBM_PACKET_TARGET), (input.mbmSkill ?? []).filter((x) => cut === null || x.session > cut)),
  );
  if (mbm) add(MBM_PACKET_TARGET, mbm.value, mbm.why, mbm.ev);

  for (const s of input.suggestions ?? []) {
    const target = typeof s.proposalTarget === 'string' ? s.proposalTarget.trim() : '';
    if (!target) continue;
    if (!isAllowedTarget(target)) {
      rejected.push({ target, reason: 'not allow-listed' });
      continue;
    }
    if (taken.has(target)) continue;
    const v = validateTunable(target, s.proposedValue);
    if (!v.ok) {
      rejected.push({ target, reason: v.reason });
      continue;
    }
    if (target === STOCK_MOVE_POINTS_TARGET) {
      // Only the deterministic bucket rule (above) may turn the stock model's points on or off.
      rejected.push({ target, reason: 'stock-move points are rule-only (not a diagnosis suggestion)' });
      continue;
    }
    if (target === MBM_PACKET_TARGET) {
      // Only the rolling-20 skill verdict rule (above) may turn the model input on or off.
      rejected.push({ target, reason: 'mbm.packet is rule-only (not a diagnosis suggestion)' });
      continue;
    }
    const cut = evidenceCutoff(target, decisions, directionOf(input.current(target), v.value));
    const ev = evidenceOf(evidenceRowsFor(target, after(input.rows, cut)));
    const gate = evidenceGate(ev);
    if (gate) {
      rejected.push({ target, reason: `${gate}${cut ? ` after the ${cut} decision` : ''}` });
      continue;
    }
    add(target, v.value, `diagnosis: ${(s.cause ?? 'suggested').slice(0, 200)} (hit ${pct(ev.hitRate)} over ${ev.n} cases)`, ev);
  }
  return { drafts, rejected };
}

// ─── The apply / reject state machine ────────────────────────────────────────

export interface ProposalLike {
  status: string;
  target: string;
  proposedValue: unknown;
  createdAt: Date;
}

export function isExpired(p: Pick<ProposalLike, 'status' | 'createdAt'>, now: Date): boolean {
  return p.status === 'PENDING' && now.getTime() - p.createdAt.getTime() > PENDING_TTL_DAYS * 86_400_000;
}

export type Decision =
  | { ok: true; status: Extract<ProposalStatus, 'APPROVED' | 'REJECTED'>; value?: TunableValue }
  | { ok: false; status?: 'EXPIRED'; reason: string };

/** PENDING → APPROVED (→ APPLIED by the caller) | REJECTED. Anything else is refused. */
export function decide(p: ProposalLike, action: 'approve' | 'reject', now: Date): Decision {
  if (p.status !== 'PENDING') return { ok: false, reason: `proposal is ${p.status}, not PENDING` };
  if (isExpired(p, now)) return { ok: false, status: 'EXPIRED', reason: `proposal is older than ${PENDING_TTL_DAYS} days` };
  if (action === 'reject') return { ok: true, status: 'REJECTED' };
  const v = validateTunable(p.target, p.proposedValue);
  if (!v.ok) return { ok: false, reason: v.reason };
  return { ok: true, status: 'APPROVED', value: v.value };
}
