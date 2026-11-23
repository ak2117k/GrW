import { reentryLiveLimitsFrom, type ReentryLiveLimits } from './domain/reentry-live-gate';

/**
 * REENTRY_WATCH=paper|off|live (default paper; docs/superpowers/specs/2026-11-05-reentry-watch-design.md,
 * live: 2026-11-23-reentry-live-design.md).
 *  - off: the cron does nothing.
 *  - paper: every watch outcome is recorded in reentry_watch_decisions and a re-entry signal opens a PAPER
 *    trade (isPaper: true, strategy REENTRY_WATCH). Paper never reaches broker order code.
 *  - live: a re-entry of a REAL exit that clears every limit (domain/reentry-live-gate.ts + reentry-live-size.ts)
 *    may be placed as a real order; everything else stays paper exactly as in `paper`.
 * Anything unrecognised falls back to paper (paper can never place a real order), with a problem line.
 * `live` holds the live limits (REENTRY_LIVE_*), parsed in every mode; their bad values are problems too.
 * Pure parse, never throws.
 */
export type ReentryWatchMode = 'off' | 'paper' | 'live';

export interface ReentryWatchConfig {
  mode: ReentryWatchMode;
  /** The live limits (§3 / §6a); only read when mode is 'live'. */
  live: ReentryLiveLimits;
  problems: string[];
}

export const REENTRY_WATCH_CONFIG = Symbol('REENTRY_WATCH_CONFIG');

export function parseReentryWatchConfig(env: Record<string, string | undefined>): ReentryWatchConfig {
  const problems: string[] = [];
  const live = reentryLiveLimitsFrom(env, problems);
  const raw = String(env.REENTRY_WATCH ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'paper') return { mode: 'paper', live, problems };
  if (raw === 'off') return { mode: 'off', live, problems };
  if (raw === 'live') return { mode: 'live', live, problems };
  return { mode: 'paper', live, problems: [`REENTRY_WATCH=${env.REENTRY_WATCH} is not paper|off|live — using paper`, ...problems] };
}

/** Trade.strategy / source / tags of a re-entry paper trade. */
export const REENTRY_STRATEGY = 'REENTRY_WATCH';
export const REENTRY_SOURCE = 'reentry-watch / paper';
export const REENTRY_TAG = 'reentry-watch';
/** `reentry-of:<watch key>` links a re-entry trade to the exited position it re-enters. */
export const REENTRY_OF_TAG = 'reentry-of:';
