import type { LessonScore, LessonVerdict, MissOutcomeType, SelfReviewMiss, SelfReviewRun } from '@/types/selfReview.types';

/**
 * "Last night" (2026-11-11): the newest reviewed session's findings by what they became, and the review's status for
 * recent weeknights — a weeknight with no run is said out loud ("No review ran for …"), never hidden. Pure.
 */

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** IST 'YYYY-MM-DD' of an instant. */
export function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'HH:MM IST' of an ISO instant ('' when unparsable). */
export function istTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return `${new Date(t.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16)} IST`;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** 'Tue 10 Nov' for a 'YYYY-MM-DD'. */
export function dayLabel(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return d;
  return `${WEEKDAY[t.getUTCDay()]} ${t.getUTCDate()} ${t.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
}

export type NightState = 'REVIEWED' | 'NO_DIAGNOSIS' | 'FAILED' | 'RUNNING' | 'MISSING' | 'PENDING';

export interface NightStatus {
  session: string;
  state: NightState;
  text: string;
  tone: 'good' | 'bad' | 'neutral';
}

/** The nightly review runs at 00:30 IST; before this IST hour the previous day's review may simply not have run yet. */
const PENDING_UNTIL_IST_HOUR = 3;

const hasDiagnosis = (r: Pick<SelfReviewRun, 'diagnosis'>) => !!r.diagnosis && typeof r.diagnosis === 'object' && Array.isArray(r.diagnosis.misses);

/**
 * The last `n` weeknights' review status, newest first. Weekends are skipped; an NSE holiday is not known here, so a
 * holiday weeknight with no run reads "No review ran" — the point is never to hide a gap.
 */
export function nightStatuses(runs: readonly SelfReviewRun[], now: Date, n = 7): NightStatus[] {
  const today = istDay(now);
  const istHour = new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();
  const out: NightStatus[] = [];
  let t = new Date(`${today}T00:00:00Z`).getTime() - DAY_MS;
  const yesterday = new Date(t).toISOString().slice(0, 10);
  for (let guard = 0; out.length < n && guard < n * 3; guard++, t -= DAY_MS) {
    const day = new Date(t);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const session = day.toISOString().slice(0, 10);
    const label = dayLabel(session);
    const mine = runs.filter((r) => r.sessionDate === session);
    const diagnosed = mine.find(hasDiagnosis);
    if (diagnosed) {
      const count = diagnosed.diagnosis?.misses?.length ?? 0;
      out.push({ session, state: 'REVIEWED', tone: 'good', text: `${label}: reviewed at ${istTime(diagnosed.finishedAt ?? diagnosed.startedAt)} — ${count} finding${count === 1 ? '' : 's'}` });
    } else if (mine.some((r) => r.status === 'RUNNING')) {
      out.push({ session, state: 'RUNNING', tone: 'neutral', text: `${label}: review running now` });
    } else if (mine.some((r) => r.status === 'DONE')) {
      out.push({ session, state: 'NO_DIAGNOSIS', tone: 'bad', text: `${label}: review ran but the AI diagnosis did not (no findings written)` });
    } else if (mine.length > 0) {
      const err = mine.find((r) => r.error)?.error;
      out.push({ session, state: 'FAILED', tone: 'bad', text: `${label}: review failed${err ? ` — ${err}` : ''}` });
    } else if (session === yesterday && istHour < PENDING_UNTIL_IST_HOUR) {
      out.push({ session, state: 'PENDING', tone: 'neutral', text: `${label}: review runs at 00:30 IST` });
    } else {
      out.push({ session, state: 'MISSING', tone: 'bad', text: `No review ran for ${label} (${session})` });
    }
  }
  return out;
}

export const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** What a finding became; an older API build without `outcome` falls back to the lesson key it named. */
export function outcomeOf(m: SelfReviewMiss): { type: MissOutcomeType | 'UNKNOWN'; label: string } {
  if (m.outcome?.label) return { type: m.outcome.type, label: m.outcome.label };
  if (m.causeType === 'NOISE' || m.category === 'NOISE') return { type: 'NOISE', label: 'Noise — no action' };
  return { type: 'UNKNOWN', label: m.lessonKey ? `Lesson key ${m.lessonKey} (status unknown)` : 'Outcome not recorded by this API build' };
}

/** "4 findings: 1 lesson, 1 fix ticket, 1 recorded only, 1 noise". */
export function outcomeTally(misses: readonly SelfReviewMiss[]): string {
  const c = { LESSON: 0, TICKET: 0, ONE_OFF: 0, NOISE: 0, UNKNOWN: 0 };
  for (const m of misses) c[outcomeOf(m).type] += 1;
  const parts = [
    c.LESSON ? `${c.LESSON} lesson${c.LESSON === 1 ? '' : 's'}` : '',
    c.TICKET ? `${c.TICKET} fix ticket${c.TICKET === 1 ? '' : 's'}` : '',
    c.ONE_OFF ? `${c.ONE_OFF} recorded only` : '',
    c.NOISE ? `${c.NOISE} noise` : '',
    c.UNKNOWN ? `${c.UNKNOWN} unknown` : '',
  ].filter(Boolean);
  return `${misses.length} finding${misses.length === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/** The finding's meta line: symbol · kind · category · causeType · ₹ cost (or "₹ unknown"). */
export function findingMeta(m: SelfReviewMiss): string {
  const cost = typeof m.costRupees === 'number' ? `cost ${rupees(m.costRupees)}/lot` : '₹ cost unknown';
  return [m.symbol, m.kind, m.category, m.causeType, cost].filter(Boolean).join(' · ');
}

// ─── Lesson scorecard ───────────────────────────────────────────────────────

export const VERDICT_LABEL: Record<LessonVerdict, string> = { TOO_EARLY: 'Too early', HELPING: 'Helping', NOT_HELPING: 'Not helping' };
export const VERDICT_TONE: Record<LessonVerdict, 'good' | 'bad' | 'neutral'> = { TOO_EARLY: 'neutral', HELPING: 'good', NOT_HELPING: 'bad' };

/** "3 in 10 sessions (0.3/session) · ₹4,500 (+2 without ₹)". */
export function windowLine(w: LessonScore['before']): string {
  if (w.sessions === 0) return 'no reviewed sessions';
  const rate = w.perSession === null ? '' : ` (${w.perSession}/session)`;
  const cost = w.mistakes === 0 ? '' : w.costUnknown === w.mistakes ? ' · ₹ unknown' : ` · ${rupees(w.costRupees)}${w.costUnknown ? ` (+${w.costUnknown} without ₹)` : ''}`;
  return `${w.mistakes} in ${w.sessions} session${w.sessions === 1 ? '' : 's'}${rate}${cost}`;
}
