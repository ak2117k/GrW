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
/** Overnight-aware window cap: the index keeps at most NEWS_INDEX_HOURS (≤ 72 h). */
export const NEWS_WINDOW_MAX_MS = 72 * 3_600_000;
const IST_OFFSET_MS = 19_800_000;

/**
 * Start of the headline window (correctness review F1, 2026-11-16). At least the last 6 h, and
 * always back to the previous NSE session close (15:30 IST of the previous weekday) so results and
 * news published after the close are still in front of the judge at the next open — the old 6 h
 * window had dropped IDEA's 18:41 results by the 08:30 overnight look. Holidays only make it reach
 * back to the previous weekday. Capped at {@link NEWS_WINDOW_MAX_MS}. Pure.
 */
export function newsWindowStart(now: number): number {
  const ist = new Date(now + IST_OFFSET_MS);
  let day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 86_400_000;
  while (new Date(day).getUTCDay() === 0 || new Date(day).getUTCDay() === 6) day -= 86_400_000;
  const prevCloseUtc = day + (15 * 60 + 30) * 60_000 - IST_OFFSET_MS;
  return Math.max(now - NEWS_WINDOW_MAX_MS, Math.min(now - NEWS_WINDOW_MS, prevCloseUtc));
}
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
