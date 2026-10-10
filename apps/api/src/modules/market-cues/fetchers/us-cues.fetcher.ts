import { parseYahooDailyChange } from '../../market-data/services/yahoo-finance.service';
import type { UsCueKey, UsQuote } from '../market-cues.types';
import { round2, venueNumber } from './ist-dates';

/**
 * US cues: the previous US session's close for the Nasdaq Composite, S&P 500 and
 * Dow (Yahoo `^IXIC`, `^GSPC`, `^DJI`), and the index futures overnight (`NQ=F`,
 * `ES=F`) at their own quote time. Fallback: CNBC's quote JSON (`.IXIC`, `.SPX`,
 * `.DJI`, `@ND.1`, `@SP.1`) in one request. `@NQ.1` is NOT a valid CNBC symbol.
 */
export const US_SYMBOLS: Record<UsCueKey, { yahoo: string; cnbc: string; future: boolean; label: string }> = {
  nasdaq: { yahoo: '^IXIC', cnbc: '.IXIC', future: false, label: 'Nasdaq Composite' },
  sp500: { yahoo: '^GSPC', cnbc: '.SPX', future: false, label: 'S&P 500' },
  dow: { yahoo: '^DJI', cnbc: '.DJI', future: false, label: 'Dow Jones Industrial Average' },
  nasdaqFutures: { yahoo: 'NQ=F', cnbc: '@ND.1', future: true, label: 'Nasdaq-100 futures (front month)' },
  sp500Futures: { yahoo: 'ES=F', cnbc: '@SP.1', future: true, label: 'S&P 500 futures (front month)' },
};

export interface ParsedUs {
  values: UsQuote;
  sourceTime: string;
}

/** A Yahoo v8 chart payload → one-day change, dated by Yahoo's own `regularMarketTime`. */
export function parseYahooCue(data: unknown, symbol: string): ParsedUs {
  const d = parseYahooDailyChange(data, symbol);
  if (!d) throw new Error(`Yahoo ${symbol}: no last two daily closes in the payload`);
  if (!d.quoteTime) throw new Error(`Yahoo ${symbol}: no regularMarketTime — age unknown`);
  return {
    values: { symbol: d.symbol, last: d.last, previousClose: d.previousClose, change: d.change, changePercent: d.changePercent },
    sourceTime: d.quoteTime,
  };
}

/** `2026-10-10T17:38:52.000-0400` → ISO UTC; a bare date stays a date. */
function cnbcTime(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(fixed);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** CNBC quote JSON → per-symbol readings. Symbols that do not parse are left out. */
export function parseCnbcQuotes(data: unknown): Record<string, ParsedUs> {
  const rows = (data as { FormattedQuoteResult?: { FormattedQuote?: unknown[] } })?.FormattedQuoteResult?.FormattedQuote;
  if (!Array.isArray(rows)) throw new Error('CNBC: no FormattedQuote array');
  const out: Record<string, ParsedUs> = {};
  for (const r of rows as Array<Record<string, unknown>>) {
    const symbol = String(r.symbol ?? '');
    const last = venueNumber(r.last);
    const prev = venueNumber(r.previous_day_closing);
    const at = cnbcTime(r.last_time);
    if (!symbol || last === null || last <= 0 || prev === null || prev <= 0 || !at) continue;
    out[symbol] = {
      values: {
        symbol,
        last,
        previousClose: prev,
        change: round2(last - prev),
        changePercent: round2(((last - prev) / prev) * 100),
      },
      sourceTime: at,
    };
  }
  return out;
}

export function yahooChartUrl(template: string, symbol: string): string {
  return template.replace('{symbol}', encodeURIComponent(symbol));
}

export function cnbcQuoteUrl(template: string, symbols: string[]): string {
  return template.replace('{symbols}', symbols.map(encodeURIComponent).join('%7C'));
}
