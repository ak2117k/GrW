/**
 * Retention for market / analysis tables, read from an env var in DAYS.
 *
 * OWNER DECISION (2026-10-21): keep all market and analysis data until the
 * application, the models and the agent are trained. So unset, empty, 0,
 * negative or garbage all mean KEEP FOREVER, and a prune job only deletes when
 * an operator sets a positive number of days on purpose.
 */
export function retentionDaysFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The delete-before instant for `days` of retention, or `null` to keep everything. */
export function retentionCutoff(days: number, now: Date = new Date()): Date | null {
  return days > 0 ? new Date(now.getTime() - days * 24 * 60 * 60 * 1000) : null;
}
