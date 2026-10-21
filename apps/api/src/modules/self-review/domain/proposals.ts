/**
 * The deterministic proposal engine (contract "Proposals"). The LLM diagnosis may SUGGEST a target
 * and value; this code decides: allow-listed target, value inside the hard bounds, ≥ 5 judged cases
 * of evidence over the rolling window, one PENDING per key. Anything else is rejected with a reason.
 */
import type { ProposalDraft, ProposalEvidence, ProposalStatus } from '../self-review.types';
import {
  clampTunable,
  isAllowedTarget,
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
}

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
  return { n: judged.length, right, wrong, examples, hitRate: judged.length ? right / judged.length : null };
}

/** The rows that are evidence for `target` (also used to vet an LLM suggestion). */
export function evidenceRowsFor(target: string, rows: readonly EvidenceRow[]): EvidenceRow[] {
  for (const f of SCORECARD_WEIGHT_FACTORS) {
    if (target === weightTarget(f)) return rows.filter((r) => r.kind === 'SCORECARD_FACTOR' && r.subject === f);
  }
  if (target === NEWS_CONFIRMATION_TARGET) {
    return rows.filter((r) => r.kind === 'SCORECARD_FACTOR' && r.subject === 'news' && det(r).newsConfirmed === false);
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
function ruleValue(target: string, cur: TunableValue, ev: { n: number; hitRate: number | null }): { value: TunableValue; why: string } | null {
  if (ev.hitRate === null || ev.n < MIN_EVIDENCE) return null;
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
    return { value: v, why: `rolling-20 hit rate ${pct(ev.hitRate)} over ${ev.n} judged cases → weight ×${low ? '0.5' : '1.25'}` };
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
      evidence: { n: ev.n, right: ev.right, wrong: ev.wrong, examples: ev.examples },
    });
  };

  for (const target of RULE_TARGETS) {
    const ev = evidenceOf(evidenceRowsFor(target, input.rows));
    const r = target === STOCK_MOVE_POINTS_TARGET ? stockMoveRule(input.current(target), input.rows) : ruleValue(target, input.current(target), ev);
    if (r) add(target, r.value, r.why, ev);
  }

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
    const ev = evidenceOf(evidenceRowsFor(target, input.rows));
    if (ev.n < MIN_EVIDENCE) {
      rejected.push({ target, reason: `only ${ev.n} judged cases (need ${MIN_EVIDENCE})` });
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
