/**
 * Decision Gate (CORE2) — the post-score structural filter for the adaptive-stop
 * track. The score gate proved non-predictive (it rewards extension; 70+ scores
 * won only 33%). This gate adds the read an experienced trader actually makes:
 * take the entry ONLY if price is (a) AT support and (b) NOT extended.
 *
 * Validated on the track's own history (≈102 trades): the two-rule core kept 35
 * trades at 57% win / +₹252 per trade, and FORWARD-VALIDATED on a chronological
 * holdout — in a held-out period where the ungated baseline lost (31% win,
 * −₹5,075), gated entries were 50% win / +₹373 per trade.
 *
 * Pure + deterministic so it unit-tests in isolation; the service fetches the
 * candles and calls evaluateDecisionGate().
 */

export interface GateCandle {
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string | Date;
}

export interface GateParams {
  /** Max % above the nearest support level to still count as "at support". */
  nearSupportPct: number;
  /** RSI(15m) at/above this = extended (chasing). */
  rsiHot: number;
  /** Entry more than this % above session VWAP = extended (chasing). */
  vwapExtPct: number;
  /**
   * When true, also require the 15m MACD histogram to be bullish (>0) at entry —
   * a higher-timeframe TREND filter. In-sample this was the only momentum signal
   * that discriminated (15m bullish 48% win / +₹7,900 vs bearish 35% / −₹3,402);
   * the fast 1m/5m MACD is noise. Experimental on the adaptive sandbox.
   */
  requireMacdBullish: boolean;
}

export interface DecisionGateResult {
  pass: boolean;
  /** True when the gate couldn't evaluate (too few candles) — caller fails OPEN. */
  skipped: boolean;
  nearSupport: boolean;
  notExtended: boolean;
  macdBullish: boolean;
  reason: string;
  detail: {
    nearestSupport: number | null;
    distSupportPct: number | null;
    rsi: number | null;
    vwapExtPct: number | null;
    macdHist: number | null;
  };
}

/** EMA series for a closes array. */
function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}

/** Latest MACD(12,26,9) histogram for a closes series, or null if too few bars. */
export function macdHistogram(closes: number[]): number | null {
  if (closes.length < 26) return null;
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const macd = closes.map((_, i) => e12[i] - e26[i]);
  const signal = emaSeries(macd, 9);
  return macd[macd.length - 1] - signal[signal.length - 1];
}

const ms = (c: GateCandle): number => new Date(c.timestamp).getTime();
const istDateKey = (epochMs: number): string =>
  new Date(epochMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * 3-bar fractal swing pivots — byte-for-byte the same rule the chart's S/R
 * engine uses (signal-generator/services/swing-pivots.ts). Swing highs are
 * resistance, swing lows are support.
 */
export function detectSwingPivots(candles: GateCandle[]): { price: number; kind: 'high' | 'low' }[] {
  const out: { price: number; kind: 'high' | 'low' }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    if (
      c.high > candles[i - 1].high && c.high > candles[i - 2].high && c.high > candles[i - 3].high &&
      c.high > candles[i + 1].high && c.high > candles[i + 2].high && c.high > candles[i + 3].high
    ) { out.push({ price: c.high, kind: 'high' }); continue; }
    if (
      c.low < candles[i - 1].low && c.low < candles[i - 2].low && c.low < candles[i - 3].low &&
      c.low < candles[i + 1].low && c.low < candles[i + 2].low && c.low < candles[i + 3].low
    ) { out.push({ price: c.low, kind: 'low' }); }
  }
  return out;
}

/** Price-adaptive round-number step (mirrors adaptive-round-numbers.ts). */
export function adaptiveRoundStep(ltp: number): number {
  if (ltp < 50) return 1;
  if (ltp < 200) return 5;
  if (ltp < 500) return 10;
  if (ltp < 2000) return 25;
  if (ltp < 5000) return 50;
  return 100;
}

/** ±3 adaptive round numbers around price. */
export function roundGrid(ltp: number): number[] {
  if (!(ltp > 0)) return [];
  const step = adaptiveRoundStep(ltp);
  const center = Math.round(ltp / step) * step;
  const out: number[] = [];
  for (let k = -3; k <= 3; k++) out.push(center + k * step);
  return out;
}

/** Wilder RSI; null when fewer than period+1 closes. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

/**
 * Evaluate the CORE2 gate. `candles15m` is a multi-day 15m series; `nowMs` is
 * the entry moment. Only candles fully closed before `nowMs` are used — no
 * look-ahead. Returns `skipped:true, pass:true` when there isn't enough data to
 * judge, so the caller fails OPEN (a data gap never suppresses an entry).
 */
export function evaluateDecisionGate(
  entry: number,
  candles15m: GateCandle[],
  nowMs: number,
  p: GateParams,
): DecisionGateResult {
  const empty = { nearestSupport: null, distSupportPct: null, rsi: null, vwapExtPct: null, macdHist: null };
  const skip = (reason: string): DecisionGateResult => ({
    pass: true, skipped: true, nearSupport: false, notExtended: false, macdBullish: false, reason, detail: empty,
  });
  if (!(entry > 0) || !Array.isArray(candles15m)) return skip('no-candles (gate skipped)');
  const before = candles15m.filter((c) => ms(c) + 15 * 60_000 <= nowMs);
  const dayKey = istDateKey(nowMs);
  const sameDay = before.filter((c) => istDateKey(ms(c)) === dayKey);
  if (before.length < 10 || sameDay.length < 3) return skip('insufficient-candles (gate skipped)');

  // --- Rule: AT SUPPORT (multi-day swing-low pivots + round numbers below) ---
  const pivots = detectSwingPivots(before);
  const supports = [
    ...pivots.filter((x) => x.kind === 'low').map((x) => x.price),
    ...roundGrid(entry),
  ].filter((price) => price < entry * 0.9995);
  const nearestSupport = supports.length ? Math.max(...supports) : null;
  const distSupportPct = nearestSupport != null ? ((entry - nearestSupport) / entry) * 100 : null;
  const nearSupport = distSupportPct != null && distSupportPct <= p.nearSupportPct;

  // --- Rule: NOT EXTENDED (session RSI + VWAP) ---
  const r = rsi(sameDay.map((c) => c.close), 14);
  let pv = 0, vv = 0;
  for (const c of sameDay) { pv += ((c.high + c.low + c.close) / 3) * (c.volume || 0); vv += c.volume || 0; }
  const vwap = vv > 0 ? pv / vv : entry;
  const vwapExtPct = ((entry - vwap) / vwap) * 100;
  const notExtended = (r == null || r < p.rsiHot) && vwapExtPct < p.vwapExtPct;

  // --- Rule: 15m TREND (higher-timeframe MACD histogram bullish) ---
  // Computed on the full multi-day 15m series so MACD(26) is valid even early
  // in the session. Only enforced when requireMacdBullish is on.
  const macdHist = macdHistogram(before.map((c) => c.close));
  const macdBullish = macdHist != null && macdHist > 0;
  const macdOk = !p.requireMacdBullish || macdBullish;

  const pass = nearSupport && notExtended && macdOk;
  const reason = pass
    ? `ok (at support, not extended${p.requireMacdBullish ? ', 15m MACD bullish' : ''})`
    : [
        !nearSupport ? `not-at-support (${distSupportPct == null ? 'none below' : distSupportPct.toFixed(2) + '% away'})` : null,
        !notExtended ? `extended (rsi=${r == null ? 'n/a' : r.toFixed(0)}, vwap+${vwapExtPct.toFixed(2)}%)` : null,
        p.requireMacdBullish && !macdBullish ? `15m MACD bearish (hist=${macdHist == null ? 'n/a' : macdHist.toFixed(3)})` : null,
      ].filter(Boolean).join('; ');

  return {
    pass, skipped: false, nearSupport, notExtended, macdBullish, reason,
    detail: { nearestSupport, distSupportPct, rsi: r, vwapExtPct, macdHist },
  };
}
