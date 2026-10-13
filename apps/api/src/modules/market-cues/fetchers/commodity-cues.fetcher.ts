import type { CommodityCueKey, CommodityQuote } from '../market-cues.types';
import { parseCnbcQuotes } from './us-cues.fetcher';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Commodity benchmarks, all from ONE CNBC quote request (the same endpoint as
 * the US fallback). Verified 2026-10-12 against the live endpoint: every symbol
 * below answered with a quote, a previous close and its own `last_time`.
 *
 * `symbol` is the ticker stored on the reading (the familiar Yahoo-style name);
 * `cnbc` is what is asked for. Futures are the FRONT month, which rolls — the
 * reading keeps CNBC's own contract name so the month is never guessed.
 *
 * `maxAgeMs`: CNBC's futures quotes are ~10 minutes delayed and refreshed here
 * every 10 minutes, so a quote older than 30 minutes means the source stopped
 * (a US holiday, the CME daily break, an outage). CNBC's `INR=` is the onshore
 * USD/INR rate, which stops updating after the Indian currency session — its
 * previous print is still the right reading for the MCX evening, so it gets 18 h.
 */
export const COMMODITY_SYMBOLS: Record<CommodityCueKey, { cnbc: string; symbol: string; label: string; maxAgeMs: number }> = {
  wtiCrude: { cnbc: '@CL.1', symbol: 'CL=F', label: 'NYMEX WTI crude futures (front month)', maxAgeMs: 0.5 * HOUR_MS },
  brentCrude: { cnbc: '@LCO.1', symbol: 'BZ=F', label: 'ICE Brent crude futures (front month)', maxAgeMs: 0.5 * HOUR_MS },
  gold: { cnbc: '@GC.1', symbol: 'GC=F', label: 'COMEX gold futures (front month)', maxAgeMs: 0.5 * HOUR_MS },
  silver: { cnbc: '@SI.1', symbol: 'SI=F', label: 'COMEX silver futures (front month)', maxAgeMs: 0.5 * HOUR_MS },
  naturalGas: { cnbc: '@NG.1', symbol: 'NG=F', label: 'NYMEX natural gas futures (front month)', maxAgeMs: 0.5 * HOUR_MS },
  copper: { cnbc: '@HG.1', symbol: 'HG=F', label: 'COMEX copper futures (front month)', maxAgeMs: 0.5 * HOUR_MS },
  usdInr: { cnbc: 'INR=', symbol: 'USDINR', label: 'USD/INR spot', maxAgeMs: 18 * HOUR_MS },
};

export interface ParsedCommodity {
  values: CommodityQuote;
  sourceTime: string;
}

/**
 * The CNBC quote JSON → one reading per benchmark it carried. A benchmark the
 * reply did not carry (or carried unparseably) is simply absent from the result;
 * the caller states it unavailable with the reason.
 */
export function parseCnbcCommodities(data: unknown): Partial<Record<CommodityCueKey, ParsedCommodity>> {
  const quotes = parseCnbcQuotes(data);
  const rows = ((data as { FormattedQuoteResult?: { FormattedQuote?: unknown[] } })?.FormattedQuoteResult?.FormattedQuote ?? []) as Array<
    Record<string, unknown>
  >;
  const names = new Map(rows.map((r) => [String(r.symbol ?? ''), typeof r.name === 'string' && r.name.trim() ? r.name.trim() : null]));
  const out: Partial<Record<CommodityCueKey, ParsedCommodity>> = {};
  for (const key of Object.keys(COMMODITY_SYMBOLS) as CommodityCueKey[]) {
    const sym = COMMODITY_SYMBOLS[key];
    const hit = quotes[sym.cnbc];
    if (!hit) continue;
    out[key] = {
      values: { ...hit.values, symbol: sym.symbol, contract: names.get(sym.cnbc) ?? null },
      sourceTime: hit.sourceTime,
    };
  }
  return out;
}
