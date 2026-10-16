/**
 * News & events v2 (docs/superpowers/specs/2026-10-16-news-events-design.md §15).
 * PURE — imports nothing: the sentinel's cycle walk reads this file.
 * The master switch is on only for the exact words `observe` / `true`; a typo is `false`.
 */
export type NewsEventsMode = 'false' | 'observe' | 'true';
export const NEWS_EVENTS_CONFIG = 'NEWS_EVENTS_CONFIG';

export interface NewsEventsConfig {
  mode: NewsEventsMode;
  computing: boolean;
  rendering: boolean;
  nseAnnCadenceMin: number;
  indexHours: number;
  indexMaxItems: number;
  wakeCooldownMin: number;
  eventWakeLeadMin: number;
  eventsHorizonTradingDays: number;
  problems: string[];
}

export const NEWS_WINDOW_MS = 6 * 3_600_000;
export const FRESH_WINDOW_MS = 30 * 60_000;
export const STALE_AFTER_MS = 30 * 60_000;
export const DELTA_POLL_MS = 60_000;
export const MAX_PER_KEY = 50;
export const LAYER_CAPS = { instrument: 8, sector: 3, index: 2, market: 2 } as const;
export const MAX_HEADLINES = 8;
export const MAX_EVENTS = 5;
export const TITLE_MAX = 160;
export const FUTURE_PUBDATE_TOLERANCE_MS = 10 * 60_000;
export const NSE_ANN_OFFHOURS_MIN = 15;
export const TAG_VERSION = 1;

export function parseNewsEventsConfig(env: Record<string, string | undefined>): NewsEventsConfig {
  const problems: string[] = [];
  const raw = (env.NEWS_EVENTS_V2_ENABLED ?? '').trim().toLowerCase();
  let mode: NewsEventsMode = 'false';
  if (raw === 'true' || raw === 'observe') mode = raw;
  else if (raw !== '' && raw !== 'false') {
    problems.push(`NEWS_EVENTS_V2_ENABLED="${env.NEWS_EVENTS_V2_ENABLED}" is not false|observe|true — treated as false`);
  }
  const int = (key: string, def: number, min: number, max: number): number => {
    const v = env[key];
    if (v === undefined || v.trim() === '') return def;
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key}=${v} is out of range [${min}, ${max}] — using ${def}`);
      return def;
    }
    return n;
  };
  return {
    mode,
    computing: mode !== 'false',
    rendering: mode === 'true',
    nseAnnCadenceMin: int('NEWS_NSE_ANN_CADENCE_MIN', 3, 1, 60),
    indexHours: int('NEWS_INDEX_HOURS', 24, 6, 72),
    indexMaxItems: int('NEWS_INDEX_MAX_ITEMS', 5000, 500, 20000),
    wakeCooldownMin: int('NEWS_WAKE_COOLDOWN_MIN', 5, 1, 60),
    eventWakeLeadMin: int('EVENT_WAKE_LEAD_MIN', 15, 1, 120),
    eventsHorizonTradingDays: int('EVENTS_HORIZON_TRADING_DAYS', 3, 1, 10),
    problems,
  };
}

export function newsEventsBootLine(c: NewsEventsConfig): string {
  return (
    `[news-events] mode=${c.mode} nseAnn=${c.nseAnnCadenceMin}m index=${c.indexHours}h/${c.indexMaxItems} ` +
    `wakeCooldown=${c.wakeCooldownMin}m eventLead=${c.eventWakeLeadMin}m horizon=${c.eventsHorizonTradingDays} trading days`
  );
}
