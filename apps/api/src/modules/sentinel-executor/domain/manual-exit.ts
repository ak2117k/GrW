// apps/api/src/modules/sentinel-executor/domain/manual-exit.ts

/**
 * Owner-triggered "Exit now" (Portfolio → Trade Tracker). It runs through the
 * same executor pipeline as the sentinel auto-exit but has no sentinel verdict,
 * so its ai_exit_executions row carries a SYNTHETIC verdictId — never a
 * sentinel_verdicts row. No schema change: the trigger is recognisable from
 * the id prefix (and the `MANUAL:` verdictReason).
 */
export type ExitTrigger = 'AI' | 'MANUAL';

export const MANUAL_VERDICT_PREFIX = 'man_';
export const MANUAL_REASON_PREFIX = 'MANUAL:';

/**
 * `man_<trackerId>_<seq>` — deterministic per (tracker, attempt number), so two
 * concurrent requests compute the same id and UNIQUE(verdictId) lets only one
 * of them claim (the double-click guard). `seq` grows only once an attempt exists.
 */
export function manualVerdictId(trackerId: string, seq: number): string {
  return `${MANUAL_VERDICT_PREFIX}${trackerId}_${seq}`;
}

export function isManualVerdictId(verdictId: string | null | undefined): boolean {
  return String(verdictId ?? '').startsWith(MANUAL_VERDICT_PREFIX);
}

export function triggerOf(verdictId: string | null | undefined): ExitTrigger {
  return isManualVerdictId(verdictId) ? 'MANUAL' : 'AI';
}
