/**
 * Auto-apply policy (spec docs/superpowers/specs/2026-11-04-self-review-wrong-decision-loop-design.md S1/S2/S4;
 * 2026-11-05). Pure. The proposal engine (domain/proposals.ts) still picks WHAT moves and gates it on
 * evidenceGate; this decides HOW FAR one automatic step may go, WHEN a target may move again, and when a
 * change must be ROLLED BACK.
 */
import { directionOf } from '../domain/proposals';
import type { NumberTunable, TunableValue } from '../tuning/tunables';
import {
  CARRY_DECIDE_BY_TARGET,
  FLOOR_ARM_N_TARGET,
  FLOOR_TRAIL_N_TARGET,
  JUDGE_DEFAULT_TAKE_TARGET,
  JUDGE_MIN_CONFIDENCE_TARGET,
  SPIKE_BANK_RISE_N_TARGET,
  SPIKE_BANK_TRAIL_N_TARGET,
} from '../tuning/tunables';

/** One automatic step moves at most this share of the tunable's range (S2). */
export const MAX_STEP_SHARE = 0.25;
/** At most one change per target per this many sessions (S2). */
export const CHANGE_SPACING_SESSIONS = 5;
/** After a rollback, no change in the same direction for this many sessions (S4). */
export const ROLLBACK_BLOCK_SESSIONS = 20;
/** Sessions WITH the affected decision on each side of a change before it is judged (S4). */
export const WATCH_SESSIONS = 3;

/**
 * The graded decision types (stream F `decision_grades.decision_type`) a target moves. A target with no
 * entry has nothing to watch a change with, so it is never auto-applied (the owner may still approve it).
 */
export const AFFECTED_DECISIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [JUDGE_MIN_CONFIDENCE_TARGET]: ['ENTRY_TAKE', 'ENTRY_SKIP'],
  [JUDGE_DEFAULT_TAKE_TARGET]: ['ENTRY_TAKE', 'ENTRY_SKIP'],
  [FLOOR_ARM_N_TARGET]: ['FLOOR', 'EXIT', 'GATED_EXIT'],
  [FLOOR_TRAIL_N_TARGET]: ['EXIT', 'FLOOR', 'GATED_EXIT'],
  [SPIKE_BANK_RISE_N_TARGET]: ['SPIKE_BANK', 'FLOOR', 'EXIT'],
  [SPIKE_BANK_TRAIL_N_TARGET]: ['SPIKE_BANK', 'FLOOR', 'EXIT'],
  [CARRY_DECIDE_BY_TARGET]: ['CARRY', 'CARRY_EXIT'],
  // PERSIST_MIN_TARGET / OPENING_GUARD_TARGET are deliberately absent (coordinator 2026-11-04): their
  // consumers re-read overrides every 60 s, so a 19:30 auto-apply would land mid MCX session (spec S7).
  // They stay owner-approval only.
});

/** How lopsided the WRONG counts must be before the evidence names a direction. */
export const DIRECTION_RATIO = 1.5;

/**
 * The direction the GRADED evidence points a target (spec S2: the code decides, never the LLM), or null when
 * it doesn't point clearly. Judge: wrong skips (missed winners) vs wrong takes. Floor / spike bank: wrong exits
 * whose better alternative was to hold (exited too early ⇒ wider, 'up') vs wrong holds whose better alternative
 * was to exit (held too long ⇒ tighter, 'down'). Booleans answer with the target value, like `directionOf`.
 */
export function evidenceDirection(target: string, wrong: ReadonlyArray<{ decisionType: string; alternative: string | null }>): string | null {
  const count = (p: (r: { decisionType: string; alternative: string | null }) => boolean) => wrong.filter(p).length;
  const lean = (a: number, b: number): 1 | -1 | 0 => (a > 0 && a >= DIRECTION_RATIO * b ? 1 : b > 0 && b >= DIRECTION_RATIO * a ? -1 : 0);
  if (target === JUDGE_MIN_CONFIDENCE_TARGET || target === JUDGE_DEFAULT_TAKE_TARGET) {
    const l = lean(count((r) => r.decisionType === 'ENTRY_SKIP'), count((r) => r.decisionType === 'ENTRY_TAKE'));
    if (l === 0) return null;
    if (target === JUDGE_DEFAULT_TAKE_TARGET) return l === 1 ? 'true' : 'false';
    return l === 1 ? 'down' : 'up';
  }
  if ([FLOOR_ARM_N_TARGET, FLOOR_TRAIL_N_TARGET, SPIKE_BANK_RISE_N_TARGET, SPIKE_BANK_TRAIL_N_TARGET].includes(target)) {
    const early = count((r) => ['EXIT', 'FLOOR', 'SPIKE_BANK', 'GATED_EXIT'].includes(r.decisionType) && /hold/i.test(r.alternative ?? ''));
    const late = count((r) => r.decisionType === 'HOLD' && /exit/i.test(r.alternative ?? ''));
    const l = lean(early, late);
    return l === 0 ? null : l === 1 ? 'up' : 'down';
  }
  return null;
}

/**
 * `to` moved toward from `from` by at most MAX_STEP_SHARE of (max − min), inside the bounds. An integer
 * tunable rounds the step TOWARD `from` (never past the limit); a step that rounds to nothing returns `from`.
 */
export function stepLimit(t: NumberTunable, from: number, to: number): number {
  const maxStep = MAX_STEP_SHARE * (t.max - t.min);
  const delta = to - from;
  let step = Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
  if (t.integer) step = Math.sign(step) * Math.floor(Math.abs(step) + 1e-9);
  let v = from + step;
  v = Math.min(t.max, Math.max(t.min, v));
  return t.integer ? Math.round(v) : Math.round(v * 1000) / 1000;
}

/** One automatic change (an APPLY of a proposal, or the ROLLBACK of one), as recorded in tuning_proposals. */
export interface Change {
  /** The tuning_proposals id. */
  id: string;
  target: string;
  kind: 'APPLY' | 'ROLLBACK';
  from: TunableValue | null;
  to: TunableValue | null;
  /** IST session date the change was made on (it takes effect from the next session's open). */
  session: string;
  at: string;
  reason: string;
  /** ROLLBACK: the APPLY it undid, and the direction now blocked for ROLLBACK_BLOCK_SESSIONS. */
  rollbackOf?: string | null;
  blockedDirection?: string | null;
  /** APPLY: the watch's state this run (WATCHING until WATCH_SESSIONS sessions with the decision). */
  watch?: 'WATCHING' | 'KEPT' | 'ROLLED_BACK' | 'SUPERSEDED' | null;
}

/** Sessions in `sessionsAsc` strictly after `session`. */
export const sessionsSince = (session: string, sessionsAsc: readonly string[]): number => sessionsAsc.filter((d) => d > session).length;

/**
 * Why `target` may not move in `direction` now, or null when it may (S2/S4):
 *  - a change on it (apply or rollback) fewer than CHANGE_SPACING_SESSIONS sessions ago;
 *  - its last automatic change is still being watched;
 *  - a rollback of a change in the same direction fewer than ROLLBACK_BLOCK_SESSIONS sessions ago.
 */
export function changeBlock(target: string, direction: string | null, history: readonly Change[], sessionsAsc: readonly string[]): string | null {
  const mine = history.filter((c) => c.target === target);
  const last = mine.reduce<Change | null>((a, c) => (a === null || c.at > a.at ? c : a), null);
  if (last) {
    const n = sessionsSince(last.session, sessionsAsc);
    if (n < CHANGE_SPACING_SESSIONS) return `${target} last changed ${n} session(s) ago (need ${CHANGE_SPACING_SESSIONS})`;
    if (last.kind === 'APPLY' && last.watch === 'WATCHING') return `${target}'s last change (${last.id}) is still being watched`;
  }
  for (const c of mine) {
    if (c.kind !== 'ROLLBACK' || !c.blockedDirection || c.blockedDirection !== direction) continue;
    const n = sessionsSince(c.session, sessionsAsc);
    if (n < ROLLBACK_BLOCK_SESSIONS) return `${target} moving ${direction} was rolled back ${n} session(s) ago (blocked for ${ROLLBACK_BLOCK_SESSIONS})`;
  }
  return null;
}

/** The plan's boolean form of {@link changeBlock}. */
export function mayChange(target: string, history: readonly Change[], sessionsAsc: readonly string[], direction: string | null = null): boolean {
  return changeBlock(target, direction, history, sessionsAsc) === null;
}

export interface WindowPnl {
  /** ₹ per affected decision, net, per lot (null when no decision was graded). */
  perDecision: number | null;
  /** Sessions in the window that HAD the decision. */
  sessions: number;
}

/**
 * S4: roll back when the WATCH_SESSIONS sessions WITH the decision after the change made less ₹ per
 * decision than the WATCH_SESSIONS such sessions before it. Too few sessions on either side, or a side
 * with no number, is never a rollback (sessions without the decision don't count).
 */
export function rollbackDue(before: WindowPnl, after: WindowPnl): boolean {
  if (before.sessions < WATCH_SESSIONS || after.sessions < WATCH_SESSIONS) return false;
  if (before.perDecision === null || after.perDecision === null) return false;
  return after.perDecision < before.perDecision;
}

/** The direction a ROLLBACK blocks: the direction of the change it undid. */
export const blockedDirectionOf = (applied: Pick<Change, 'from' | 'to'>): string | null => directionOf(applied.from, applied.to);
