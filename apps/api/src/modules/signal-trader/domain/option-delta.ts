/**
 * An option's |delta| when no greek was read (no chain leg, no broker optionGreek). Pure.
 *
 * Black-Scholes N(d1) with r = 0 from the SPOT, the strike, the time left to expiry and an implied
 * volatility (the chain leg's IV, else India VIX for an index, else a flat guess). Called a MONEYNESS
 * HEURISTIC on every record that uses it: it is not a quote. Also: a chain row that carries only the
 * other leg's delta gives this leg by put-call parity (|Δce| ≈ 1 − |Δpe|).
 */
export type OptionKind = 'CE' | 'PE';

/** The flat IV guess when neither the leg's IV nor VIX is known (single stocks run ~25–40 %). */
export const DEFAULT_STOCK_IV = 0.3;
export const DEFAULT_INDEX_IV = 0.15;
/** Expiry at 15:30 IST; never price fewer than this many days (an expiry-day option is still not a step). */
const MIN_DAYS = 0.05;

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Standard normal CDF (Abramowitz–Stegun 26.2.17; |error| < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Calendar days from `now` to the expiry's 15:30 IST (expiry YYYY-MM-DD, an IST date). */
export function daysToExpiry(expiry: string | Date | null | undefined, now: Date): number | null {
  if (!expiry) return null;
  const ymd = typeof expiry === 'string' ? expiry.slice(0, 10) : new Date(expiry.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const close = Date.parse(`${ymd}T10:00:00.000Z`); // 15:30 IST
  if (!Number.isFinite(close)) return null;
  return Math.max(MIN_DAYS, (close - now.getTime()) / 86_400_000);
}

/** |delta| by Black-Scholes (r = 0). iv as a fraction (0.21) or a percent (21). null on bad inputs. */
export function bsAbsDelta(i: { spot: number; strike: number; kind: OptionKind; days: number; iv: number }): number | null {
  const { spot, strike, kind } = i;
  if (!(spot > 0) || !(strike > 0) || !(i.days > 0) || !(i.iv > 0)) return null;
  const sigma = i.iv > 3 ? i.iv / 100 : i.iv;
  const t = i.days / 365;
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * t) / (sigma * Math.sqrt(t));
  const callDelta = normCdf(d1);
  return r4(kind === 'CE' ? callDelta : 1 - callDelta);
}

export interface DeltaReading {
  /** |delta|, 0..1. */
  abs: number;
  /** Where it came from: 'chain' | 'broker' | 'chain-parity' | 'moneyness-heuristic (…)' | 'packet' | 'linear (non-option)'. */
  source: string;
}

/**
 * The delta ladder for a judge packet / a re-score: a read greek (as given) → the other leg by parity
 * → the moneyness heuristic. null only when not even spot / strike / expiry are known.
 */
export function deltaReading(i: {
  kind: string;
  read?: number | null;
  readSource?: string;
  otherLegDelta?: number | null;
  spot: number | null;
  strike: number | null;
  expiry: string | Date | null;
  now: Date;
  iv?: number | null;
  vix?: number | null;
  index: boolean;
}): DeltaReading | null {
  if (i.kind !== 'CE' && i.kind !== 'PE') return { abs: 1, source: 'linear (non-option: the contract moves 1:1 with its underlying)' };
  if (typeof i.read === 'number' && Number.isFinite(i.read) && Math.abs(i.read) > 0 && Math.abs(i.read) <= 1) return { abs: r4(Math.abs(i.read)), source: i.readSource ?? 'chain' };
  if (typeof i.otherLegDelta === 'number' && Number.isFinite(i.otherLegDelta) && Math.abs(i.otherLegDelta) < 1) {
    return { abs: r4(1 - Math.abs(i.otherLegDelta)), source: 'chain-parity (1 − |other leg delta|, same strike and expiry)' };
  }
  const days = daysToExpiry(i.expiry, i.now);
  if (i.spot === null || i.strike === null || days === null) return null;
  const ivFrom = typeof i.iv === 'number' && i.iv > 0 ? { v: i.iv, w: 'leg IV' } : i.index && typeof i.vix === 'number' && i.vix > 0 ? { v: i.vix, w: 'India VIX' } : { v: i.index ? DEFAULT_INDEX_IV : DEFAULT_STOCK_IV, w: 'flat guess' };
  const abs = bsAbsDelta({ spot: i.spot, strike: i.strike, kind: i.kind, days, iv: ivFrom.v });
  if (abs === null) return null;
  const pct = Math.round((ivFrom.v > 3 ? ivFrom.v : ivFrom.v * 100) * 10) / 10;
  return { abs, source: `moneyness-heuristic (Black-Scholes from spot, ${Math.round(days * 100) / 100} d to expiry, σ ${pct}% = ${ivFrom.w}; not a quote)` };
}
