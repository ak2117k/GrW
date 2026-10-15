// apps/api/src/modules/sentinel-executor/domain/manual-exit.ts

/**
 * Owner-triggered "Exit now" (Portfolio → Trade Tracker). It runs through the
 * same executor pipeline as the sentinel auto-exit but has no sentinel verdict,
 * so its ai_exit_executions row carries a SYNTHETIC verdictId — never a
 * sentinel_verdicts row. No schema change: the trigger is recognisable from
 * the id prefix (and the `MANUAL:` verdictReason).
 */
export type ExitTrigger = 'AI' | 'MANUAL' | 'PRICE_TRIGGER';

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

/** Synthetic verdictId of a price-trigger fire: `trg_<sentinel_exit_triggers.id>` (price-triggers plan R13). */
export const PRICE_TRIGGER_VERDICT_PREFIX = 'trg_';

export function triggerVerdictId(triggerId: string): string {
  return `${PRICE_TRIGGER_VERDICT_PREFIX}${triggerId}`;
}

export function triggerIdOf(verdictId: string | null | undefined): string | null {
  const v = String(verdictId ?? '');
  return v.startsWith(PRICE_TRIGGER_VERDICT_PREFIX) ? v.slice(PRICE_TRIGGER_VERDICT_PREFIX.length) : null;
}

export function triggerOf(verdictId: string | null | undefined): ExitTrigger {
  if (isManualVerdictId(verdictId)) return 'MANUAL';
  return triggerIdOf(verdictId) !== null ? 'PRICE_TRIGGER' : 'AI';
}
