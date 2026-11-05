/**
 * REENTRY_WATCH=paper|off (default paper; docs/superpowers/specs/2026-11-05-reentry-watch-design.md).
 *  - off: the cron does nothing.
 *  - paper: every watch outcome is recorded in reentry_watch_decisions and a re-entry signal opens a PAPER
 *    trade (isPaper: true, strategy REENTRY_WATCH). There is no live mode: this module never reaches broker
 *    order code. Anything unrecognised falls back to paper (paper can never place a real order).
 * Pure parse, never throws.
 */
export type ReentryWatchMode = 'off' | 'paper';

export interface ReentryWatchConfig {
  mode: ReentryWatchMode;
  problems: string[];
}

export const REENTRY_WATCH_CONFIG = Symbol('REENTRY_WATCH_CONFIG');

export function parseReentryWatchConfig(env: Record<string, string | undefined>): ReentryWatchConfig {
  const raw = String(env.REENTRY_WATCH ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'paper') return { mode: 'paper', problems: [] };
  if (raw === 'off') return { mode: 'off', problems: [] };
  return { mode: 'paper', problems: [`REENTRY_WATCH=${env.REENTRY_WATCH} is not paper|off — using paper`] };
}

/** Trade.strategy / source / tags of a re-entry paper trade. */
export const REENTRY_STRATEGY = 'REENTRY_WATCH';
export const REENTRY_SOURCE = 'reentry-watch / paper';
export const REENTRY_TAG = 'reentry-watch';
/** `reentry-of:<watch key>` links a re-entry trade to the exited position it re-enters. */
export const REENTRY_OF_TAG = 'reentry-of:';
