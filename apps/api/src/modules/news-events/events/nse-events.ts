import { istAt, nseDateToYmd } from '../../market-cues/fetchers/ist-dates';
import type { MarketEventInput } from '../types';

export const NSE_EVENT_CALENDAR_URL = 'https://www.nseindia.com/api/event-calendar?index=equities';
export const nseCorporateActionsUrl = (fromDdMmYyyy: string, toDdMmYyyy: string) =>
  `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${fromDdMmYyyy}&to_date=${toDdMmYyyy}`;

const s = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
function listOf(json: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : null;
  if (!rows) throw new Error('response is not a list');
  return rows.map((r) => (r ?? {}) as Record<string, unknown>);
}
function dedupe(xs: MarketEventInput[]): MarketEventInput[] {
  const seen = new Set<string>();
  return xs.filter((e) => {
    const k = `${e.kind}|${e.key}|${e.startsAt.toISOString()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
/** All-day company events sit at 09:15 IST of their date (the NSE open) — minutesAway is "today" from then on. */
const dayStart = (ymd: string) => istAt(ymd, 9, 15);

export function parseEventCalendar(json: unknown): MarketEventInput[] {
  const out: MarketEventInput[] = [];
  for (const r of listOf(json)) {
    const symbol = s(r.symbol).toUpperCase();
    const purpose = s(r.purpose);
    const ymd = nseDateToYmd(s(r.date));
    if (!symbol || !purpose || !ymd) continue;
    const results = /result/i.test(`${purpose} ${s(r.bm_desc)}`);
    out.push({
      scope: 'company', kind: results ? 'results' : 'board_meeting', key: symbol,
      title: `${symbol} ${results ? 'financial results' : 'board meeting'}: ${purpose}`.slice(0, 160),
      startsAt: dayStart(ymd), allDay: true, impact: 'high', source: 'NSE event calendar', sourceRef: `${symbol}|${s(r.date)}|${purpose}`,
    });
  }
  return dedupe(out);
}

export function parseCorporateActions(json: unknown): MarketEventInput[] {
  const out: MarketEventInput[] = [];
  for (const r of listOf(json)) {
    const symbol = s(r.symbol).toUpperCase();
    const subject = s(r.subject);
    const ymd = nseDateToYmd(s(r.exDate));
    if (!symbol || !subject || !ymd) continue;
    const kind = /dividend/i.test(subject) ? 'ex_dividend' : /split|sub-division/i.test(subject) ? 'split' : /bonus/i.test(subject) ? 'bonus' : 'corporate_action';
    out.push({
      scope: 'company', kind, key: symbol, title: `${symbol} ex-date: ${subject}`.slice(0, 160),
      startsAt: dayStart(ymd), allDay: true, impact: 'medium', source: 'NSE corporate actions', sourceRef: `${symbol}|${s(r.exDate)}|${subject}`,
    });
  }
  return dedupe(out);
}

export function yahooEarningsEvent(symbol: string, raw: string | undefined): MarketEventInput | null {
  const t = s(raw);
  const ymd = /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : nseDateToYmd(t);
  if (!ymd) return null;
  return {
    scope: 'company', kind: 'results', key: symbol.toUpperCase(), title: `${symbol.toUpperCase()} results (estimate)`,
    startsAt: dayStart(ymd), allDay: true, impact: 'high', source: 'yahoo (estimate)', sourceRef: `yahoo:${symbol.toUpperCase()}:${ymd}`,
  };
}
