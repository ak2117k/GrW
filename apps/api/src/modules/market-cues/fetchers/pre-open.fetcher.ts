import type { PreOpenBook, PreOpenEntry } from '../market-cues.types';
import { istDateTimeToIso, nseDateToYmd, venueNumber } from './ist-dates';

/**
 * NSE pre-open — `api/market-data-pre-open?key=FO`, ~220 KB, an IEP (indicative
 * equilibrium price) per symbol.
 *
 * WHAT IT ACTUALLY PRICES. The payload fetched on 2026-10-10 (Friday's session)
 * held only `series: "EQ"` rows: the CASH pre-open of the F&O securities, not
 * the F&O futures pre-open NSE has run since 8-Dec-2025 (current-month index
 * and stock futures; orders 09:00–09:08, matching 09:08–09:10). Rows are
 * therefore classified by what they are — EQ → CASH, an identifier naming a
 * future → FUTURE — and every consumer labels the IEP by that, never assuming
 * it is a futures price. MCX has no price-discovery pre-open at all.
 */
export function parseNsePreOpen(data: unknown): PreOpenBook {
  const d = data as { data?: unknown[]; timestamp?: string };
  const rows = Array.isArray(d?.data) ? (d.data as Array<Record<string, unknown>>) : [];
  if (rows.length === 0) throw new Error('NSE pre-open: no pre-open rows (no session yet, or a holiday)');
  const stamp = istDateTimeToIso(d.timestamp ?? '');
  const entries: Record<string, PreOpenEntry> = {};
  for (const row of rows) {
    const m = (row.metadata ?? {}) as Record<string, unknown>;
    const pom = ((row.detail as Record<string, unknown> | undefined)?.preOpenMarket ?? {}) as Record<string, unknown>;
    const symbol = String(m.symbol ?? '').trim().toUpperCase();
    const iep = venueNumber(m.iep ?? pom.IEP);
    const previousClose = venueNumber(m.previousClose ?? pom.prevClose);
    const at = istDateTimeToIso(String(pom.lastUpdateTime ?? '')) ?? stamp;
    if (!symbol || iep === null || iep <= 0 || previousClose === null || previousClose <= 0 || !at) continue;
    const identifier = String(m.identifier ?? '').toUpperCase();
    const series = String(m.series ?? '').toUpperCase();
    const instrument: PreOpenEntry['instrument'] = /FUT/.test(identifier) || /FUT/.test(series) ? 'FUTURE' : 'CASH';
    entries[symbol] = {
      symbol,
      instrument,
      iep,
      previousClose,
      change: venueNumber(m.change),
      changePercent: venueNumber(m.pChange),
      at,
    };
  }
  const date = nseDateToYmd(d.timestamp ?? '') ?? (Object.values(entries)[0]?.at.slice(0, 10) ?? null);
  if (Object.keys(entries).length === 0 || !date) throw new Error('NSE pre-open: no row carried an IEP and a previous close');
  return { date, entries };
}
