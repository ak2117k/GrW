import type { LevelCandidate } from '../types/evidence-level.types';

/**
 * Minimal OHLCV input shape for the dynamic S/R detectors. Mirrors the
 * `ProfileCandle` style in volume-profile.ts but adds `volume` explicitly
 * (anchored VWAP needs it). All detectors here are PURE — no IO; the
 * orchestrator fetches candles and passes them in oldest→newest.
 */
export interface DynamicCandle {
  high: number;
  low: number;
  close: number;
  volume: number;
}

const MA_SPECS: ReadonlyArray<{ period: number; score: number }> = [
  { period: 20, score: 8 },
  { period: 50, score: 14 },
  { period: 200, score: 20 },
];

/** True when `price` is effectively equal to `ltp` (relative epsilon). */
function equalsLtp(price: number, ltp: number): boolean {
  return Math.abs(price - ltp) <= 1e-6 * Math.max(1, Math.abs(ltp));
}

/**
 * Moving-average S/R levels (kind 'MA').
 *
 * Uses the SIMPLE moving average (SMA) of close — chosen over EMA for
 * deterministic, hand-verifiable output and because round-trip S/R reads from
 * the level itself, not its responsiveness. The 20 / 50 / 200 SMAs are emitted,
 * length-weighted (the 200 is the most-watched institutional line, so it scores
 * strongest): 200→20, 50→14, 20→8.
 *
 * An MA is skipped when there are fewer candles than its period (the average
 * would be ill-defined) or when it lands on the live price (a level at spot is
 * not actionable S/R). Returns [] when no MA qualifies.
 */
export function maLevels(candles: DynamicCandle[], ltp: number): LevelCandidate[] {
  const out: LevelCandidate[] = [];
  if (!Array.isArray(candles) || candles.length === 0) return out;

  for (const { period, score } of MA_SPECS) {
    if (candles.length < period) continue;
    const window = candles.slice(candles.length - period);
    const sum = window.reduce((acc, k) => acc + k.close, 0);
    const sma = sum / period;
    if (!(sma > 0) || equalsLtp(sma, ltp)) continue;
    out.push({ price: sma, kind: 'MA', score });
  }
  return out;
}

/** Typical price of a bar: (high + low + close) / 3. */
function typical(k: DynamicCandle): number {
  return (k.high + k.low + k.close) / 3;
}

/**
 * Volume-weighted average price anchored at `from` and computed forward to the
 * latest bar, using typical price. Falls back to a simple mean of typical
 * prices when the window carries no volume (so a zero-volume feed still yields a
 * level rather than NaN).
 */
function vwapFrom(candles: DynamicCandle[], from: number): number {
  let pv = 0;
  let vol = 0;
  let tpSum = 0;
  let n = 0;
  for (let i = from; i < candles.length; i++) {
    const tp = typical(candles[i]);
    const v = Number(candles[i].volume) || 0;
    pv += tp * v;
    vol += v;
    tpSum += tp;
    n += 1;
  }
  if (n === 0) return NaN;
  return vol > 0 ? pv / vol : tpSum / n;
}

const AVWAP_SCORE = 25;

/**
 * Anchored-VWAP S/R levels (kind 'AVWAP', score ~25).
 *
 * Anchors at the most significant recent swing extremes in the window — the
 * highest-high bar and the lowest-low bar — and runs VWAP forward from each to
 * the latest bar. These are the prices the "marginal buyer/seller since the
 * extreme" sits at, and tend to act as dynamic support/resistance. Emits one
 * level per distinct anchor (deduped when the high and low anchor coincide or
 * resolve to the same VWAP). Skips a level that lands on the live price.
 *
 * Returns [] for fewer than 2 candles (no meaningful anchor window).
 */
export function anchoredVwap(candles: DynamicCandle[], ltp: number): LevelCandidate[] {
  const out: LevelCandidate[] = [];
  if (!Array.isArray(candles) || candles.length < 2) return out;

  let idxHigh = 0;
  let idxLow = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].high > candles[idxHigh].high) idxHigh = i;
    if (candles[i].low < candles[idxLow].low) idxLow = i;
  }

  const anchors = idxHigh === idxLow ? [idxHigh] : [idxHigh, idxLow];
  const seen: number[] = [];
  for (const a of anchors) {
    const price = vwapFrom(candles, a);
    if (!(price > 0) || equalsLtp(price, ltp)) continue;
    if (seen.some((p) => equalsLtp(p, price))) continue;
    seen.push(price);
    out.push({ price, kind: 'AVWAP', score: AVWAP_SCORE });
  }
  return out;
}
