/**
 * MARKET EVENT DAYS (2026-11-03). Scheduled events that make an Indian session's opening move bigger
 * than usual — volatility / gap awareness only, never a direction. Pure: no I/O, no clock.
 *
 *   MARKET_EVENT_DAYS   comma-separated `YYYY-MM-DD:NAME` (IST session dates), e.g.
 *                       "2026-11-04:US_MIDTERM_RESULTS,2026-12-10:FOMC". Unset → {@link DEFAULT_MARKET_EVENT_DAYS};
 *                       "off" / "none" → no events. Malformed entries are ignored.
 *
 * Uses: the 08:30 pre-open outlook prints an "Event:" line; every trades row entered on an event
 * day carries `EVENT:<NAME>` in entryTags (trade-execution.service) so the nightly self-review can
 * separate event-day results.
 */

export interface MarketEvent {
  /** IST session date, YYYY-MM-DD. */
  date: string;
  /** SCREAMING_SNAKE name, e.g. US_MIDTERM_RESULTS. */
  name: string;
}

/** Code default (used when MARKET_EVENT_DAYS is unset): US midterm results land ~05:30–09:30 IST Wed 4 Nov 2026. */
export const DEFAULT_MARKET_EVENT_DAYS = '2026-11-04:US_MIDTERM_RESULTS';

export const EVENT_TAG_PREFIX = 'EVENT:';

/** Plain-English labels for the outlook line; unknown names are shown as words. */
const EVENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  US_MIDTERM_RESULTS: 'US midterm results overnight',
});

type Env = Record<string, string | undefined>;
const ENTRY_RE = /^(\d{4}-\d{2}-\d{2})\s*:\s*([A-Za-z0-9_]+)$/;

/** The configured events (env → else the code default). */
export function marketEvents(env: Env = process.env): MarketEvent[] {
  const raw = env.MARKET_EVENT_DAYS === undefined ? DEFAULT_MARKET_EVENT_DAYS : env.MARKET_EVENT_DAYS;
  const s = raw.trim();
  if (['', 'off', 'none', 'false', '0'].includes(s.toLowerCase())) return [];
  const out: MarketEvent[] = [];
  for (const part of s.split(',')) {
    const m = ENTRY_RE.exec(part.trim());
    if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) continue;
    const ev = { date: m[1], name: m[2].toUpperCase() };
    if (!out.some((e) => e.date === ev.date && e.name === ev.name)) out.push(ev);
  }
  return out;
}

/** The IST date (YYYY-MM-DD) of `at`. */
function istYmd(at: Date): string {
  return new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** Events whose IST session date is the IST date of `at`. */
export function activeEvents(at: Date, env: Env = process.env): MarketEvent[] {
  const d = istYmd(at);
  return marketEvents(env).filter((e) => e.date === d);
}

/** `EVENT:<NAME>` per active event at `at`. */
export function eventTags(at: Date, env: Env = process.env): string[] {
  return activeEvents(at, env).map((e) => `${EVENT_TAG_PREFIX}${e.name}`);
}

/** `tags` plus the event tags active at `at` (no duplicates; order kept; the input is not mutated). */
export function withEventTags(tags: readonly string[] | null | undefined, at: Date, env: Env = process.env): string[] {
  const base = [...(tags ?? [])];
  for (const t of eventTags(at, env)) if (!base.includes(t)) base.push(t);
  return base;
}

/** "US midterm results overnight" (known) / "rbi policy" (unknown name as words). */
export function eventLabel(name: string): string {
  return EVENT_LABELS[name] ?? name.toLowerCase().replace(/_/g, ' ');
}
