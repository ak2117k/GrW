import { createHash } from 'crypto';
import { istDateTimeToIso, istMinutes } from '../../market-cues/fetchers/ist-dates';
import { NSE_ANN_OFFHOURS_MIN } from '../config';

export const NSE_ANNOUNCEMENTS_URL = 'https://www.nseindia.com/api/corporate-announcements?index=equities';
const TITLE_CAP = 300;

export interface ParsedAnnouncement { symbol: string; title: string; summary: string; url: string; publishedAt: Date | null; dateInferred: boolean }

function str(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

function when(r: Record<string, unknown>): Date | null {
  const a = istDateTimeToIso(str(r.an_dt));
  if (a) return new Date(a);
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(str(r.sort_date));
  return m ? new Date(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}+05:30`) : null;
}

/** Spec §4.2. Throws on a body that is not a list — the caller records that as a source failure. */
export function parseAnnouncements(json: unknown): ParsedAnnouncement[] {
  const rows = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : null;
  if (!rows) throw new Error('response is not an announcements list');
  const out: ParsedAnnouncement[] = [];
  for (const raw of rows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const symbol = str(r.symbol).toUpperCase();
    const desc = str(r.desc);
    if (!symbol || !desc) continue;
    const text = str(r.attchmntText);
    const full = text ? `${symbol}: ${desc} — ${text}` : `${symbol}: ${desc}`;
    const title = full.length > TITLE_CAP ? `${full.slice(0, TITLE_CAP - 1)}…` : full;
    const at = when(r);
    const file = str(r.attchmntFile);
    const url =
      file ||
      `https://www.nseindia.com/companies-listing/corporate-filings-announcements#${symbol}-${createHash('sha1')
        .update(`${symbol}|${desc}|${text}|${str(r.sort_date)}`)
        .digest('hex')
        .slice(0, 12)}`;
    out.push({ symbol, title, summary: text.slice(0, 500), url, publishedAt: at, dateInferred: at === null });
  }
  return out;
}

/** N3: every `cadenceMin` 09:00–17:30 IST on NSE trading days, every 15 min 07:00–22:00 otherwise, never 22:00–07:00. */
export function announcementsDue(now: Date, lastRunAt: Date | null, cadenceMin: number, isTradingDay: boolean): boolean {
  const m = istMinutes(now);
  const inSession = isTradingDay && m >= 9 * 60 && m <= 17 * 60 + 30;
  const inOffHours = m >= 7 * 60 && m <= 22 * 60;
  if (!inSession && !inOffHours) return false;
  const every = (inSession ? cadenceMin : NSE_ANN_OFFHOURS_MIN) * 60_000;
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= every - 5_000;
}
