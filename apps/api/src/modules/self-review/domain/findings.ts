/**
 * "Last night" findings (2026-11-11): what each diagnosed miss BECAME — a lesson, a fix ticket, a recorded one-off,
 * or noise — and the lesson scorecard (is each lesson making its mistake rarer?). Pure; the service loads the rows.
 *
 * The match is exact: a miss' `lessonKey` is an `agent_lessons.key` (the stored diagnosis is already lesson-gated,
 * see lessonGated), and a ticket is found by the same `ticketKey(cause, {title, files})` the run used to write it.
 */
import { ACTIONABLE_MAX_SESSIONS, ACTIONABLE_MIN_COST_RUPEES, ACTIONABLE_MIN_OCCURRENCES } from '../diagnose/actionable';
import type { DiagnosisMissOut } from '../self-review.ports';
import { ticketKey } from '../tickets/decision-loop';

export type MissOutcomeType = 'LESSON' | 'TICKET' | 'ONE_OFF' | 'NOISE';

export interface MissOutcome {
  type: MissOutcomeType;
  /** Plain words for the page, e.g. "Lesson: floor-hard-needs-padverse (active)". */
  label: string;
  /** The lesson / ticket key when it became one. */
  key?: string;
  /** The lesson's (ACTIVE | RETIRED) or ticket's (OPEN | DONE | WONTFIX) status. */
  status?: string;
}

export interface LessonRef {
  key: string;
  status: string;
}
export interface TicketRef {
  key: string;
  title: string;
  status: string;
}

export const ONE_OFF_LABEL = `Recorded only — one-off (needs ${ACTIONABLE_MIN_OCCURRENCES} repeats in ${ACTIONABLE_MAX_SESSIONS} sessions or ≥₹${ACTIONABLE_MIN_COST_RUPEES.toLocaleString('en-IN')})`;
export const NOISE_LABEL = 'Noise — no action';

export const DECISION_REF_PREFIX = 'dg:';
/** The decision_grades id behind a `dg:<id>` refId; null for the other kinds. */
export const decisionGradeId = (refId: string): string | null => (refId.startsWith(DECISION_REF_PREFIX) ? refId.slice(DECISION_REF_PREFIX.length) : null);

/** The fix_tickets key a miss' ticket would have been written under; null when it carries none or is not CODE_BUG / DATA. */
export function missTicketKey(m: Pick<DiagnosisMissOut, 'causeType' | 'ticket'>): string | null {
  if ((m.causeType !== 'CODE_BUG' && m.causeType !== 'DATA') || !m.ticket?.title) return null;
  return ticketKey(m.causeType, { title: m.ticket.title, files: Array.isArray(m.ticket.files) ? m.ticket.files : [] });
}

/** Ticket keys of a set of misses (for one batched read). */
export function ticketKeysOf(misses: readonly DiagnosisMissOut[]): string[] {
  return [...new Set(misses.map(missTicketKey).filter((k): k is string => !!k))];
}

/**
 * What a diagnosed miss became. NOISE first (it never acts); then a fix ticket with that exact key; then a lesson with
 * that exact key; otherwise it was recorded only (the pattern gate held it back as a one-off).
 */
export function missOutcome(m: DiagnosisMissOut, lessons: ReadonlyMap<string, LessonRef>, tickets: ReadonlyMap<string, TicketRef>): MissOutcome {
  if (m.causeType === 'NOISE' || m.category === 'NOISE') return { type: 'NOISE', label: NOISE_LABEL };
  const tk = missTicketKey(m);
  const t = tk ? tickets.get(tk) : undefined;
  if (t) return { type: 'TICKET', label: `Fix ticket: ${t.title} (${t.status})`, key: t.key, status: t.status };
  const l = m.lessonKey ? lessons.get(m.lessonKey) : undefined;
  if (l) return { type: 'LESSON', label: `Lesson: ${l.key} (${l.status.toLowerCase()})`, key: l.key, status: l.status };
  return { type: 'ONE_OFF', label: ONE_OFF_LABEL };
}

/** ₹ a miss cost: the summed |delta| of its decision-ledger refs; null when none of them has a ₹ figure. */
export function missCostRupees(refIds: readonly string[], costByRef: ReadonlyMap<string, number | null | undefined>): number | null {
  let sum = 0;
  let known = false;
  for (const r of new Set(refIds)) {
    const c = costByRef.get(r);
    if (typeof c === 'number' && Number.isFinite(c)) {
      sum += Math.abs(c);
      known = true;
    }
  }
  return known ? Math.round(sum) : null;
}

// ─── Lesson scorecard ───────────────────────────────────────────────────────

/** Fewer reviewed sessions than this since a lesson went active ⇒ TOO_EARLY. */
export const SCORECARD_MIN_AFTER_SESSIONS = 5;
/** HELPING needs the per-session rate after to be at most this fraction of the rate before. */
export const SCORECARD_HELPING_RATIO = 0.5;

export type LessonVerdict = 'TOO_EARLY' | 'HELPING' | 'NOT_HELPING';

export const SCORECARD_RULE =
  `TOO_EARLY until ${SCORECARD_MIN_AFTER_SESSIONS} reviewed sessions since the lesson went active; then HELPING if its mistake happens at most half as often per reviewed session as before, otherwise NOT_HELPING.`;

/**
 * The verdict rule (pure). Rates are mistakes per reviewed session. HELPING needs a baseline (at least one mistake
 * before) and an after-rate ≤ half the before-rate; anything else after 5 sessions is NOT_HELPING.
 */
export function lessonVerdict(w: { beforeSessions: number; beforeCount: number; afterSessions: number; afterCount: number }): LessonVerdict {
  if (w.afterSessions < SCORECARD_MIN_AFTER_SESSIONS) return 'TOO_EARLY';
  if (w.beforeSessions <= 0 || w.beforeCount <= 0) return 'NOT_HELPING';
  const before = w.beforeCount / w.beforeSessions;
  const after = w.afterCount / w.afterSessions;
  return after <= before * SCORECARD_HELPING_RATIO ? 'HELPING' : 'NOT_HELPING';
}

/** The IST calendar date of an instant (lessons go active at a run's time; sessions are IST dates). */
export function istDate(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d) : d;
  return new Date(t.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export interface ScorecardRun {
  sessionDate: string;
  diagnosis: unknown;
}
export interface ScorecardLesson {
  id: string;
  key: string;
  text: string;
  scope: string;
  status: string;
  firstSeen: Date | string;
  rightCount: number;
  wrongCount: number;
}
/** What is known about a miss' refId: its own session (a ledger row is re-diagnosed for up to 10 nights) and ₹. */
export interface RefInfo {
  sessionDate?: string | null;
  costRupees?: number | null;
}

export interface WindowStats {
  sessions: number;
  mistakes: number;
  /** Mistakes per reviewed session; null with no sessions. */
  perSession: number | null;
  /** ₹ of the mistakes that have a ₹ figure (absolute, summed). */
  costRupees: number;
  /** Mistakes counted without a ₹ figure. */
  costUnknown: number;
  /** ₹ per reviewed session; null with no sessions. */
  costPerSession: number | null;
}

export interface LessonScore {
  id: string;
  key: string;
  text: string;
  scope: string;
  status: string;
  /** IST date the lesson went active (its firstSeen). */
  activeSince: string;
  rightCount: number;
  wrongCount: number;
  before: WindowStats;
  after: WindowStats;
  verdict: LessonVerdict;
}

export interface LessonScorecard {
  rule: string;
  reviewedSessions: number;
  lessons: LessonScore[];
}

function missesOf(diagnosis: unknown): DiagnosisMissOut[] {
  const m = diagnosis && typeof diagnosis === 'object' ? (diagnosis as { misses?: unknown }).misses : null;
  return Array.isArray(m) ? m.filter((x): x is DiagnosisMissOut => !!x && typeof x === 'object' && Array.isArray((x as DiagnosisMissOut).refIds)) : [];
}

/** True when the run's diagnosis is a stored diagnosis object (a reviewed session). */
export const isDiagnosed = (diagnosis: unknown): boolean => !!diagnosis && typeof diagnosis === 'object' && Array.isArray((diagnosis as { misses?: unknown }).misses);

/** Every refId any run's diagnosis named (for one batched ₹ / session read). */
export function scorecardRefIds(runs: readonly ScorecardRun[]): string[] {
  const out = new Set<string>();
  for (const r of runs) for (const m of missesOf(r.diagnosis)) if (m.lessonKey) m.refIds.forEach((id) => typeof id === 'string' && out.add(id));
  return [...out];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function windowStats(sessions: number, mistakes: Array<{ cost: number | null }>): WindowStats {
  const known = mistakes.filter((m) => m.cost !== null);
  const cost = Math.round(known.reduce((s, m) => s + Math.abs(m.cost as number), 0));
  return {
    sessions,
    mistakes: mistakes.length,
    perSession: sessions > 0 ? round2(mistakes.length / sessions) : null,
    costRupees: cost,
    costUnknown: mistakes.length - known.length,
    costPerSession: sessions > 0 ? Math.round(cost / sessions) : null,
  };
}

/**
 * The lesson scorecard (pure). A lesson's mistake = a diagnosed miss naming its key; one per refId across all runs
 * (the 00:30 / 02:30 / 09:00 runs of a night, and the ledger's 10-night look-back, repeat the same refIds), placed in
 * the refId's own session when known, else the run's. Before = reviewed sessions (sessions with a diagnosed run)
 * dated before the IST day the lesson went active; after = that day onwards.
 */
export function lessonScorecard(runs: readonly ScorecardRun[], lessons: readonly ScorecardLesson[], refs: ReadonlyMap<string, RefInfo>): LessonScorecard {
  const reviewed = [...new Set(runs.filter((r) => isDiagnosed(r.diagnosis)).map((r) => r.sessionDate))].sort();
  const byKey = new Map<string, Map<string, { session: string; cost: number | null }>>();
  for (const run of runs) {
    for (const m of missesOf(run.diagnosis)) {
      if (!m.lessonKey) continue;
      const seen = byKey.get(m.lessonKey) ?? new Map<string, { session: string; cost: number | null }>();
      for (const refId of new Set(m.refIds)) {
        if (typeof refId !== 'string' || seen.has(refId)) continue;
        const info = refs.get(refId);
        const c = info?.costRupees;
        seen.set(refId, { session: info?.sessionDate || run.sessionDate, cost: typeof c === 'number' && Number.isFinite(c) ? c : null });
      }
      byKey.set(m.lessonKey, seen);
    }
  }
  const scores = lessons.map((l): LessonScore => {
    const since = istDate(l.firstSeen);
    const mistakes = [...(byKey.get(l.key)?.values() ?? [])];
    const beforeSessions = reviewed.filter((s) => s < since).length;
    const afterSessions = reviewed.length - beforeSessions;
    const before = windowStats(beforeSessions, mistakes.filter((m) => m.session < since));
    const after = windowStats(afterSessions, mistakes.filter((m) => m.session >= since));
    return {
      id: l.id,
      key: l.key,
      text: l.text,
      scope: l.scope,
      status: l.status,
      activeSince: since,
      rightCount: l.rightCount,
      wrongCount: l.wrongCount,
      before,
      after,
      verdict: lessonVerdict({ beforeSessions, beforeCount: before.mistakes, afterSessions, afterCount: after.mistakes }),
    };
  });
  const order: Record<LessonVerdict, number> = { NOT_HELPING: 0, HELPING: 1, TOO_EARLY: 2 };
  scores.sort((a, b) => (a.status === b.status ? 0 : a.status === 'ACTIVE' ? -1 : 1) || order[a.verdict] - order[b.verdict] || b.activeSince.localeCompare(a.activeSince) || a.key.localeCompare(b.key));
  return { rule: SCORECARD_RULE, reviewedSessions: reviewed.length, lessons: scores };
}
