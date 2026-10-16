import { istAt, istYmd } from '../../market-cues/fetchers/ist-dates';
import type { SessionClock } from '../../market-hub/session-clock';
import { MAX_EVENTS } from '../config';
import type { EventView, EventsPeek, NewsPosition, StoredMarketEvent } from '../types';
import { addDaysYmd, istLabel } from './zoned-time';

type Clock = Pick<SessionClock, 'isTradingDay' | 'tradingWindow'>;
export interface SelectOptions { horizonTradingDays: number; clock: Clock; scheduleEndsAt: string | null; sourceNotes: string[]; fetchedAt: string | null }

const INDIAN = new Set(['NSE', 'BSE', 'NFO', 'BFO']);
const IMPACT_RANK = { high: 0, medium: 1, low: 2 } as const;

/** End (23:59:59.999 IST) of the n-th trading day of `exchange`, counting today when it is one. */
export function horizonEnd(exchange: string, now: Date, n: number, clock: Clock): number {
  const today = istYmd(now);
  let count = 0;
  for (let i = 0; i < 30; i++) {
    const day = addDaysYmd(today, i);
    if (clock.isTradingDay(exchange, istAt(day, 12))) {
      count++;
      if (count === n) return istAt(day, 23, 59).getTime() + 59_999;
    }
  }
  return now.getTime() + 7 * 86_400_000;
}

export function relevant(e: StoredMarketEvent, p: NewsPosition): boolean {
  if (e.scope === 'company') return p.kind === 'STOCK' && e.key === p.key;
  if (e.scope === 'commodity') return p.kind === 'COMMODITY' && e.key === p.key;
  if (e.scope === 'market') return e.key === 'US' || (e.key === 'IN' && INDIAN.has(p.exchange));
  return false;
}

export function expiryEvent(p: NewsPosition, clock: Clock): StoredMarketEvent | null {
  if (!p.expiry) return null;
  const closeMin = clock.tradingWindow(p.exchange, istAt(p.expiry, 12))?.closeMin ?? (p.exchange === 'MCX' ? 23 * 60 + 30 : 15 * 60 + 30);
  return {
    id: `expiry:${p.key}:${p.expiry}`, scope: 'expiry', kind: 'expiry', key: p.key,
    title: `${p.underlying} contract expiry (${p.exchange} close)`, startsAt: istAt(p.expiry, Math.floor(closeMin / 60), closeMin % 60),
    allDay: false, impact: 'high', source: 'position contract expiry', sourceRef: null, fetchedAt: new Date(0),
  };
}

export function selectEvents(all: readonly StoredMarketEvent[], p: NewsPosition, now: Date, o: SelectOptions): EventsPeek {
  const nowMs = now.getTime();
  const end = horizonEnd(p.exchange, now, o.horizonTradingDays, o.clock);
  const today = istYmd(now);
  const exp = expiryEvent(p, o.clock);
  const cands = [...all.filter((e) => relevant(e, p)), ...(exp ? [exp] : [])]
    .filter((e) => e.startsAt.getTime() <= end && (e.allDay ? istYmd(e.startsAt) >= today : e.startsAt.getTime() >= nowMs))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact]);
  const view = (e: StoredMarketEvent): EventView => {
    const day = istYmd(e.startsAt);
    return {
      id: e.id, kind: e.kind, scope: e.scope, title: e.title, impact: e.impact, source: e.source, allDay: e.allDay,
      atIst: e.allDay ? `${day} (time not announced)` : istLabel(e.startsAt),
      minutesAway: e.allDay && day === today ? 0 : Math.max(0, Math.round((e.startsAt.getTime() - nowMs) / 60_000)),
    };
  };
  const timedHigh = cands.filter((e) => e.impact === 'high' && !e.allDay);
  const allDayHigh = cands.find((e) => e.impact === 'high' && e.allDay);
  const minutesToNextHighImpact = timedHigh.length ? Math.max(0, Math.round((timedHigh[0].startsAt.getTime() - nowMs) / 60_000)) : null;
  const notes = [
    ...(o.scheduleEndsAt && Date.parse(o.scheduleEndsAt) - nowMs < 30 * 86_400_000 ? [`macro schedule ends ${o.scheduleEndsAt}`] : []),
    ...o.sourceNotes,
  ];
  return {
    status: 'ok',
    events: cands.slice(0, MAX_EVENTS).map(view),
    minutesToNextHighImpact,
    noHighImpactReason: minutesToNextHighImpact !== null ? null
      : `no timed high-impact event in the next ${o.horizonTradingDays} trading days` +
        (allDayHigh ? `; ${allDayHigh.title} on ${istYmd(allDayHigh.startsAt)} (time not announced)` : ''),
    notes,
    fetchedAt: o.fetchedAt,
  };
}
