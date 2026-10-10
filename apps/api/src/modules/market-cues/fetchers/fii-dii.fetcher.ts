import type { BuySellNet, FiiDiiCash } from '../market-cues.types';
import { nseDateToYmd, venueNumber } from './ist-dates';

/**
 * FII/DII cash-market flows.
 *
 * Primary: NSE `api/fiidiiTradeReact` — `[{category:'DII'|'FII/FPI', date:
 * '09-Oct-2026', buyValue, sellValue, netValue}]`, ₹ crore. NSE publishes it
 * around 18:00–20:00 IST, so a 15:45 read can never see that day's figure.
 *
 * Fallback: the NSDL FPI daily page. FPI only (no DII), and ONE DAY BEHIND:
 * the figures reported on date D are the trades of the previous trading day.
 */
export function parseNseFiiDii(data: unknown): { values: FiiDiiCash; sourceTime: string } {
  if (!Array.isArray(data)) throw new Error('NSE fiidii: payload is not an array');
  const rows = data as Array<Record<string, unknown>>;
  const pick = (test: (c: string) => boolean) => rows.find((r) => test(String(r.category ?? '').toUpperCase()));
  const fiiRow = pick((c) => c.startsWith('FII') || c.includes('FPI'));
  const diiRow = pick((c) => c === 'DII');
  if (!fiiRow) throw new Error('NSE fiidii: no FII/FPI row');
  const fii = bsn(fiiRow);
  if (!fii) throw new Error('NSE fiidii: FII row has no buy/sell/net values');
  const date = nseDateToYmd(String(fiiRow.date ?? ''));
  if (!date) throw new Error(`NSE fiidii: unreadable date "${String(fiiRow.date)}"`);
  const diiDate = diiRow ? nseDateToYmd(String(diiRow.date ?? '')) : null;
  const dii = diiRow && diiDate === date ? bsn(diiRow) : null;
  return { values: { date, fii, dii, unit: '₹ crore' }, sourceTime: date };
}

function bsn(r: Record<string, unknown>): BuySellNet | null {
  const buy = venueNumber(r.buyValue);
  const sell = venueNumber(r.sellValue);
  const net = venueNumber(r.netValue);
  return buy === null || sell === null || net === null ? null : { buy, sell, net };
}

/**
 * The NSDL "Latest" page: the reporting date and the Equity / Stock Exchange
 * row (gross purchases, gross sales, net investment, ₹ crore; negatives in
 * parentheses). The caller dates it to the previous trading day.
 */
export function parseNsdlLatest(html: string): { reportDate: string; fii: BuySellNet } {
  const dateM = /Daily Trends in FPI Investments on\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(html);
  const reportDate = dateM ? nseDateToYmd(dateM[1]) : null;
  if (!reportDate) throw new Error('NSDL: no reporting date on the page');
  const cell = `<td[^>]*>\\s*([^<]+?)\\s*</td>`;
  const rowM = new RegExp(`>\\s*Equity\\s*</td>\\s*<td[^>]*>\\s*Stock Exchange\\s*</td>\\s*${cell}\\s*${cell}\\s*${cell}`, 'i').exec(html);
  if (!rowM) throw new Error('NSDL: no Equity / Stock Exchange row');
  const [buy, sell, net] = [rowM[1], rowM[2], rowM[3]].map(venueNumber);
  if (buy === null || sell === null || net === null) throw new Error('NSDL: Equity row values unreadable');
  return { reportDate, fii: { buy, sell, net } };
}
