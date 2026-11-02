/**
 * Global price input (owner 2026-11-02): the overnight move in WTI / Brent is the most reliable
 * pre-open read for MCX crude (prod 2 Nov: WTI −3.2 % between the Fri 23:30 IST MCX close and Mon
 * 08:30 IST; MCX crude opened −3.7 %). Source: Yahoo Finance's public v8 chart endpoint (no auth),
 * verified from the prod server 2026-11-02 for BZ=F / CL=F / ES=F, interval=1h&range=5d. Pure.
 *
 * LICENSING: like market-cues, a free unofficial source — owner's own use only, never tenant-facing.
 */

export const GLOBAL_SYMBOLS = Object.freeze({
  WTI: 'CL=F',
  BRENT: 'BZ=F',
  SP500_FUT: 'ES=F',
} as const);

export const GLOBAL_SNAPSHOT_SYMBOLS: readonly string[] = Object.freeze([GLOBAL_SYMBOLS.WTI, GLOBAL_SYMBOLS.BRENT, GLOBAL_SYMBOLS.SP500_FUT]);

export const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1h&range=5d';

/** A price this much older than the evaluation is STALE (US holiday, weekend before the reopen, outage). */
export const GLOBAL_STALE_MS = 6 * 3_600_000;

export interface ChartBar {
  /** Bar open (ms epoch). */
  t: number;
  close: number;
}

export interface GlobalChart {
  symbol: string;
  /** The last trade price and its time (meta.regularMarketPrice / regularMarketTime). */
  price: number | null;
  priceAt: number | null;
  /** Bar width in ms (1h → 3 600 000). */
  intervalMs: number;
  bars: ChartBar[];
}

const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Yahoo v8 chart JSON → GlobalChart. Throws on a payload without a result (the caller records NO_DATA). */
export function parseYahooChart(data: unknown, fallbackSymbol: string): GlobalChart {
  const result = (data as { chart?: { result?: unknown[]; error?: { description?: string } | null } })?.chart?.result?.[0] as
    | { meta?: Record<string, unknown>; timestamp?: unknown[]; indicators?: { quote?: Array<{ close?: unknown[] }> } }
    | undefined;
  if (!result || !result.meta) {
    const err = (data as { chart?: { error?: { description?: string } | null } })?.chart?.error?.description;
    throw new Error(`Yahoo ${fallbackSymbol}: no chart result${err ? ` (${err})` : ''}`);
  }
  const meta = result.meta;
  const ts = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const bars: ChartBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = Number(ts[i]);
    const c = closes[i];
    if (Number.isFinite(t) && ok(c)) bars.push({ t: t * 1000, close: c });
  }
  const gran = String(meta.dataGranularity ?? '1h');
  const m = /^(\d+)(m|h|d)$/.exec(gran);
  const intervalMs = m ? Number(m[1]) * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000) : 3_600_000;
  const priceAt = Number(meta.regularMarketTime);
  if (bars.length === 0 && !ok(meta.regularMarketPrice)) throw new Error(`Yahoo ${fallbackSymbol}: no prices in the payload`);
  return {
    symbol: String(meta.symbol ?? fallbackSymbol),
    price: ok(meta.regularMarketPrice) ? meta.regularMarketPrice : null,
    priceAt: Number.isFinite(priceAt) && priceAt > 0 ? priceAt * 1000 : null,
    intervalMs,
    bars,
  };
}

/**
 * The price known at `t` (no look-ahead): the close of the last bar that had ENDED by `t`, or the
 * last trade (meta) when it is at or before `t` and later than that bar's end. null when nothing.
 */
export function priceAt(c: GlobalChart, t: number): { price: number; at: number } | null {
  let best: { price: number; at: number } | null = null;
  for (const b of c.bars) {
    const end = b.t + c.intervalMs;
    if (end <= t && (!best || end > best.at)) best = { price: b.close, at: end };
  }
  if (c.price !== null && c.priceAt !== null && c.priceAt <= t && (!best || c.priceAt > best.at)) best = { price: c.price, at: c.priceAt };
  return best;
}

export type GlobalStatus = 'OK' | 'STALE' | 'NO_DATA';

export interface GlobalMove {
  status: GlobalStatus;
  symbol: string;
  from: { price: number; at: string } | null;
  to: { price: number; at: string } | null;
  /** % move from → to (e.g. −3.21). null without both ends. */
  movePct: number | null;
  source: string;
  reason?: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** The move between the price known at `fromT` (the Indian / MCX last close) and at `toT` (now). */
export function chartMove(c: GlobalChart | null, fromT: number, toT: number, source: string, why?: string): GlobalMove {
  const sym = c?.symbol ?? '?';
  if (!c) return { status: 'NO_DATA', symbol: sym, from: null, to: null, movePct: null, source, reason: why ?? 'no chart' };
  const a = priceAt(c, fromT);
  const b = priceAt(c, toT);
  if (!a || !b) return { status: 'NO_DATA', symbol: sym, from: null, to: null, movePct: null, source, reason: !a ? 'no price at the last close' : 'no price now' };
  const movePct = r2(((b.price - a.price) / a.price) * 100);
  const stale = toT - b.at > GLOBAL_STALE_MS;
  return {
    status: stale ? 'STALE' : 'OK',
    symbol: sym,
    from: { price: r2(a.price), at: new Date(a.at).toISOString() },
    to: { price: r2(b.price), at: new Date(b.at).toISOString() },
    movePct,
    source,
    ...(stale ? { reason: `latest price is ${Math.round((toT - b.at) / 3_600_000)} h old` } : {}),
  };
}
