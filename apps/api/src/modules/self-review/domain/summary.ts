/** A run's `summary` JSON (contract §Data): hit rates per kind and factor, rolling 5 / 20 sessions. */
import type { FactorStats, KindStats, NotableItem, RunSummary, VerificationDraft, VerificationKind } from '../self-review.types';

const rate = (right: number, wrong: number): number | null =>
  right + wrong === 0 ? null : Math.round((right / (right + wrong)) * 1000) / 1000;

export function kindStats(rows: ReadonlyArray<Pick<VerificationDraft, 'correct'>>): KindStats {
  let right = 0;
  let wrong = 0;
  let nullCount = 0;
  for (const r of rows) {
    if (r.correct === true) right++;
    else if (r.correct === false) wrong++;
    else nullCount++;
  }
  return { n: rows.length, right, wrong, nullCount, hitRate: rate(right, wrong) };
}

export interface HistoryRow {
  sessionDate: string;
  subject: string | null;
  correct: boolean | null;
}

/** Hit rate of `subject` over the given sessions. */
export function rollingRate(history: readonly HistoryRow[], subject: string, sessions: readonly string[]): { right: number; wrong: number; hitRate: number | null } {
  const set = new Set(sessions);
  let right = 0;
  let wrong = 0;
  for (const h of history) {
    if (h.subject !== subject || !set.has(h.sessionDate)) continue;
    if (h.correct === true) right++;
    else if (h.correct === false) wrong++;
  }
  return { right, wrong, hitRate: rate(right, wrong) };
}

/** Wrong calls of the session, biggest |score| first (unscored last), capped. */
export function topMisses<T extends Pick<VerificationDraft, 'correct' | 'score'>>(rows: readonly T[], cap: number): T[] {
  return rows
    .filter((r) => r.correct === false)
    .sort((a, b) => (b.score === null ? -1 : Math.abs(b.score)) - (a.score === null ? -1 : Math.abs(a.score)))
    .slice(0, cap);
}

/**
 * @param results   every result of session `session` (all kinds)
 * @param history   SCORECARD_FACTOR results of the last ≥ 20 sessions (session included)
 * @param sessions  closed NSE sessions, newest first, `session` first
 */
export function buildSummary(
  session: string,
  results: readonly VerificationDraft[],
  history: readonly HistoryRow[],
  sessions: readonly string[],
): RunSummary {
  const byKind: RunSummary['byKind'] = {};
  const kinds = new Map<VerificationKind, VerificationDraft[]>();
  for (const r of results) kinds.set(r.kind, [...(kinds.get(r.kind) ?? []), r]);
  for (const [k, rows] of kinds) byKind[k] = kindStats(rows);

  const byFactor: Record<string, FactorStats> = {};
  const factorRows = kinds.get('SCORECARD_FACTOR') ?? [];
  const names = new Set<string>([
    ...factorRows.map((r) => r.subject).filter((s): s is string => !!s),
    ...history.map((h) => h.subject).filter((s): s is string => !!s),
  ]);
  const last5 = sessions.slice(0, 5);
  const last20 = sessions.slice(0, 20);
  for (const name of [...names].sort()) {
    const today = kindStats(factorRows.filter((r) => r.subject === name));
    byFactor[name] = {
      n: today.n,
      right: today.right,
      wrong: today.wrong,
      hitRate: today.hitRate,
      rolling5: rollingRate(history, name, last5).hitRate,
      rolling20: rollingRate(history, name, last20).hitRate,
    };
  }

  const notable: NotableItem[] = topMisses(results.filter((r) => r.kind !== 'SCORECARD_FACTOR' && r.kind !== 'MBM_PREDICTION' && r.kind !== 'STOCK_MOVE'), 5).map((r) => ({
    kind: r.kind,
    refId: r.refId,
    symbol: r.symbol,
    why: `${r.predicted} → ${r.actual}`.slice(0, 240),
  }));

  return { session, byKind, byFactor, notable };
}
