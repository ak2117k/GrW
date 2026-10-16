import type { Prisma } from '@prisma/client';
import type { EventsPeek, NewsPeek } from '../../news-events/types';
import type { Block } from './context-packet.service';

/**
 * News & events v2 (spec §7/§8): the packet blocks built from the two synchronous
 * peeks. PURE — no I/O, no clock (the caller passes `at`). Used by the live packet
 * with NEWS_EVENTS_V2_ENABLED=true and by the observe-mode shadow; with the flag
 * off nothing here runs and the packet is byte-identical to main.
 */

type J = Prisma.InputJsonValue;
const ok = <T>(value: T, source: string, at: string): Block<T> => ({ available: true, value, source, at });
const no = (reason: string): Block<never> => ({ available: false, reason });

export const NEWS_V2_SOURCE = 'news-index (own → sector → index → market, published within 6h)';
export const FRESH_V2_SOURCE = 'news-index (own-instrument headlines in the last 30 minutes; inferred publish times excluded)';
export const ASOF_SOURCE = 'news ingestion health (last successful fetch of any source; sources failing 6+ times in a row)';
export const EVENTS_SOURCE =
  'market-events (NSE event calendar and corporate actions, Yahoo estimates, config/market-events.json, EIA rules, contract expiry)';
export const NEXT_HIGH_SOURCE = 'market-events (timed high-impact events only)';

export interface NewsBlocksV2 {
  headlines: Block<J>;
  freshCount: Block<number>;
  asOf: Block<J>;
}
export interface EventsBlocksV2 {
  upcoming: Block<J>;
  minutesToNextHighImpact: Block<number>;
}

/** HH:MM in IST (UTC+5:30, no DST) of an ISO instant. */
const hhmmIst = (iso: string) => new Date(Date.parse(iso) + 19_800_000).toISOString().slice(11, 16);

export function allNewsAbsent(reason: string): NewsBlocksV2 {
  return { headlines: no(reason), freshCount: no(reason), asOf: no(reason) };
}
export function allEventsAbsent(reason: string): EventsBlocksV2 {
  return { upcoming: no(reason), minutesToNextHighImpact: no(reason) };
}

/** Spec §7: the layered headlines, the 30-min own count and the ingestion health. Pure. */
export function newsBlocksV2(peek: NewsPeek | null, at: string): NewsBlocksV2 {
  if (!peek) return allNewsAbsent('the news index is not wired into this process');
  if (peek.status !== 'ok') return allNewsAbsent(peek.reason);
  const { asOf } = peek;
  const asOfText = asOf.lastIngestAt ? `${hhmmIst(asOf.lastIngestAt)} IST` : 'never';
  const problems = [
    asOf.stale ? `news ingestion is stale (last at ${asOfText})` : null,
    asOf.downSources.length ? `these sources are down: ${asOf.downSources.join(', ')}` : null,
  ].filter((x): x is string => x !== null);
  const caveat = problems.length ? ` — but ${problems.join(' and ')}, so this may be a failure to see rather than a quiet market` : '';
  return {
    headlines: peek.headlines.length
      ? ok(
          peek.headlines.map((h) => ({ ...h })) as unknown as J,
          asOf.stale ? `${NEWS_V2_SOURCE} — STALE: news as of ${asOfText}` : NEWS_V2_SOURCE,
          peek.newestAt ?? at,
        )
      : no(`no headline about this instrument, its sector, its index or the market was published in the last 6 hours${caveat}`),
    freshCount: ok(peek.freshCount, FRESH_V2_SOURCE, at),
    asOf: ok({ lastIngestAt: asOf.lastIngestAt, downSources: [...asOf.downSources], stale: asOf.stale } as J, ASOF_SOURCE, asOf.lastIngestAt ?? at),
  };
}

/** Spec §8: the next ≤ 5 events (7 fields each) and the minutes to the nearest timed high-impact one. Pure. */
export function eventsBlocks(peek: EventsPeek | null, at: string, horizonDays: number): EventsBlocksV2 {
  if (!peek) return allEventsAbsent('the events calendar is not wired into this process');
  if (peek.status !== 'ok') return allEventsAbsent(peek.reason);
  const notes = peek.notes.length ? ` — ${peek.notes.join('; ')}` : '';
  return {
    upcoming: peek.events.length
      ? ok(
          peek.events.map(({ kind, scope, title, atIst, minutesAway, impact, source }) => ({ kind, scope, title, atIst, minutesAway, impact, source })) as J,
          `${EVENTS_SOURCE}${notes}`,
          peek.fetchedAt ?? at,
        )
      : no(`no scheduled event relevant to this position in the next ${horizonDays} trading days${notes}`),
    minutesToNextHighImpact:
      peek.minutesToNextHighImpact !== null
        ? ok(peek.minutesToNextHighImpact, NEXT_HIGH_SOURCE, at)
        : no(peek.noHighImpactReason ?? `no timed high-impact event in the next ${horizonDays} trading days`),
  };
}

/** One line for `[news-shadow]` (observe mode). */
export function shadowSummary(s: { news: NewsBlocksV2; events: EventsBlocksV2 }): string {
  const h = s.news.headlines;
  let head: string;
  if (h.available) {
    const items = h.value as unknown as Array<{ layer: string }>;
    const by = ['instrument', 'sector', 'index', 'market']
      .map((l) => [l, items.filter((x) => x.layer === l).length] as const)
      .filter(([, n]) => n > 0);
    head = `headlines=${items.length} (${by.map(([l, n]) => `${l} ${n}`).join(', ')})`;
  } else head = `headlines absent: ${h.reason.slice(0, 80)}`;
  const fresh = s.news.freshCount.available ? `fresh=${s.news.freshCount.value}` : 'fresh=absent';
  const ev = s.events.upcoming.available ? `events=${(s.events.upcoming.value as unknown as unknown[]).length}` : 'events=0';
  const next = s.events.minutesToNextHighImpact.available ? `nextHigh=${s.events.minutesToNextHighImpact.value}m` : 'nextHigh=none';
  const a = s.news.asOf.available ? (s.news.asOf.value as unknown as { stale: boolean; downSources: string[] }) : null;
  const asOf = a ? `stale=${a.stale} down=[${a.downSources.join(',')}]` : 'asOf=absent';
  return [head, fresh, ev, next, asOf].join(' ');
}
