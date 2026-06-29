// Pure indicator math for the levels-context confluence layer.
// Self-contained — no external libs, no NestJS imports. Each function
// returns the LATEST reading from the input series, or null if the
// series is too short. Callers pass close-price arrays.

export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed EMA with the SMA of the first `period` values — standard
  // convention; avoids the bias of seeding with the first close alone.
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function rsi(closes: number[], period = 14): number | null {
  if (period <= 0 || closes.length < period + 1) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  // Wilder smoothing for the rest of the series.
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < slow + signal) return null;
  // Build the MACD line as a series so we can EMA it for the signal line.
  const k = (p: number) => 2 / (p + 1);
  const seedSma = (p: number) => {
    let s = 0;
    for (let i = 0; i < p; i++) s += closes[i];
    return s / p;
  };
  // Build EMA series starting at index `period - 1`.
  const buildEma = (p: number): number[] => {
    const out: number[] = [];
    let prev = seedSma(p);
    out.push(prev);
    const kk = k(p);
    for (let i = p; i < closes.length; i++) {
      prev = closes[i] * kk + prev * (1 - kk);
      out.push(prev);
    }
    return out;
  };
  const fastEma = buildEma(fast); // length = closes.length - fast + 1
  const slowEma = buildEma(slow); // length = closes.length - slow + 1
  // Align: fastEma is `slow - fast` entries longer at the start.
  const offset = slow - fast;
  const macdLine: number[] = [];
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(fastEma[i + offset] - slowEma[i]);
  }
  if (macdLine.length < signal) return null;
  // Signal = EMA(signal) of the MACD line.
  let sig = 0;
  for (let i = 0; i < signal; i++) sig += macdLine[i];
  sig /= signal;
  const ks = k(signal);
  for (let i = signal; i < macdLine.length; i++) {
    sig = macdLine[i] * ks + sig * (1 - ks);
  }
  const macdNow = macdLine[macdLine.length - 1];
  return { macd: macdNow, signal: sig, histogram: macdNow - sig };
}

export function bollinger(
  closes: number[],
  period = 20,
  stdDev = 2,
): { upper: number; middle: number; lower: number } | null {
  if (period <= 0 || closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  let sum = 0;
  for (const v of window) sum += v;
  const mean = sum / period;
  let varSum = 0;
  for (const v of window) {
    const d = v - mean;
    varSum += d * d;
  }
  const sd = Math.sqrt(varSum / period);
  return { upper: mean + stdDev * sd, middle: mean, lower: mean - stdDev * sd };
}

export function roc(closes: number[], period = 10): number | null {
  if (period <= 0 || closes.length <= period) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - period];
  if (then === 0) return null;
  return ((now - then) / then) * 100;
}

/**
 * Average True Range (ATR) using Wilder's smoothing.
 * Returns the latest ATR value, or null if `highs.length < period + 1`.
 * Standard period is 14.
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number | null {
  if (highs.length !== lows.length || lows.length !== closes.length) return null;
  if (highs.length < period + 1) return null;

  // True ranges
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }

  // Wilder's smoothing: first ATR is simple avg of first `period` TRs.
  // Subsequent: ATR_t = ((period-1) * ATR_{t-1} + TR_t) / period.
  let avg = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    avg = ((period - 1) * avg + trs[i]) / period;
  }
  return avg;
}

/**
 * SuperTrend indicator (period=10, multiplier=3 standard).
 * Returns the latest SuperTrend state: { value, direction } where
 *   direction = 'UP' | 'DOWN'.
 * Returns null if insufficient candles (need at least period+1).
 *
 * Algorithm (matches the common TradingView formulation):
 *   basicUpper = (high + low) / 2 + multiplier * ATR
 *   basicLower = (high + low) / 2 - multiplier * ATR
 *   finalUpper / finalLower follow the standard "carry the prior band
 *   unless price breaks through" rule. Direction flips when close crosses
 *   the active band.
 */
export interface SuperTrendResult {
  value: number;
  direction: 'UP' | 'DOWN';
}

export function supertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 10,
  multiplier = 3,
): SuperTrendResult | null {
  if (highs.length !== lows.length || lows.length !== closes.length) return null;
  if (highs.length < period + 1) return null;

  // Compute rolling ATR series (one ATR per bar from index `period` onwards).
  // We'll compute the supertrend iteratively, tracking final upper/lower bands.
  const atrs: number[] = new Array(highs.length).fill(NaN);

  // True range series
  const trs: number[] = [0];
  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }

  // Seed: simple avg over first `period` TRs (starting at index 1)
  let atrAvg = 0;
  for (let i = 1; i <= period; i++) atrAvg += trs[i];
  atrAvg /= period;
  atrs[period] = atrAvg;
  for (let i = period + 1; i < highs.length; i++) {
    atrAvg = ((period - 1) * atrAvg + trs[i]) / period;
    atrs[i] = atrAvg;
  }

  // Compute supertrend state
  let prevFinalUpper = 0;
  let prevFinalLower = 0;
  let prevDirection: 'UP' | 'DOWN' = 'UP';
  let lastValue = 0;
  let lastDirection: 'UP' | 'DOWN' = 'UP';

  for (let i = period; i < highs.length; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const basicUpper = hl2 + multiplier * atrs[i];
    const basicLower = hl2 - multiplier * atrs[i];

    const finalUpper =
      i === period || basicUpper < prevFinalUpper || closes[i - 1] > prevFinalUpper
        ? basicUpper
        : prevFinalUpper;
    const finalLower =
      i === period || basicLower > prevFinalLower || closes[i - 1] < prevFinalLower
        ? basicLower
        : prevFinalLower;

    let direction: 'UP' | 'DOWN';
    let value: number;

    if (i === period) {
      // Seed direction: compare close to (upper+lower)/2 — standard convention
      direction = closes[i] > hl2 ? 'UP' : 'DOWN';
      value = direction === 'UP' ? finalLower : finalUpper;
    } else {
      if (prevDirection === 'UP' && closes[i] < finalLower) {
        direction = 'DOWN';
        value = finalUpper;
      } else if (prevDirection === 'DOWN' && closes[i] > finalUpper) {
        direction = 'UP';
        value = finalLower;
      } else {
        direction = prevDirection;
        value = direction === 'UP' ? finalLower : finalUpper;
      }
    }

    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevDirection = direction;
    lastValue = value;
    lastDirection = direction;
  }

  return { value: lastValue, direction: lastDirection };
}

/**
 * Average Directional Index (ADX) — Wilder's formulation. Measures the
 * STRENGTH of a trend (not its direction). Returns the latest ADX value,
 * or null when there are insufficient candles.
 *
 * Interpretation (standard reference levels):
 *   ADX < 20  → range-bound / weak trend
 *   20-25     → developing trend
 *   > 25      → strong trend (momentum entries work best here)
 *   > 40      → very strong trend
 *
 * Needs at least `2 * period` bars to seed the +DI/-DI and then ADX
 * smoothing — returns null below that.
 */
export function adx(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number | null {
  if (period <= 0) return null;
  if (highs.length !== lows.length || lows.length !== closes.length) return null;
  if (highs.length < 2 * period + 1) return null;

  // 1. For each bar i >= 1, compute TR, +DM, -DM
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    const tr = Math.max(hl, hc, lc);
    trs.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  // 2. Wilder-smooth TR, +DM, -DM. First value = simple sum/avg of first
  //    `period` items; subsequent: smoothed_t = ((p-1)*smoothed_{t-1} + raw_t) / p.
  //    We also build the DX series so we can Wilder-smooth it into ADX.
  let smoothedTR = 0;
  let smoothedPlusDM = 0;
  let smoothedMinusDM = 0;
  for (let i = 0; i < period; i++) {
    smoothedTR += trs[i];
    smoothedPlusDM += plusDMs[i];
    smoothedMinusDM += minusDMs[i];
  }
  smoothedTR /= period;
  smoothedPlusDM /= period;
  smoothedMinusDM /= period;

  // DX at the seed bar (index = period - 1 in trs[], i.e. bar `period` of the
  // original series). Then accumulate DX values across the rest of the series.
  if (smoothedTR === 0) return null;
  const computeDX = (sPlusDM: number, sMinusDM: number, sTR: number): number => {
    const plusDI = 100 * (sPlusDM / sTR);
    const minusDI = 100 * (sMinusDM / sTR);
    const denom = plusDI + minusDI;
    if (denom === 0) return 0;
    return (100 * Math.abs(plusDI - minusDI)) / denom;
  };

  const dxSeries: number[] = [];
  dxSeries.push(computeDX(smoothedPlusDM, smoothedMinusDM, smoothedTR));

  for (let i = period; i < trs.length; i++) {
    smoothedTR = ((period - 1) * smoothedTR + trs[i]) / period;
    smoothedPlusDM = ((period - 1) * smoothedPlusDM + plusDMs[i]) / period;
    smoothedMinusDM = ((period - 1) * smoothedMinusDM + minusDMs[i]) / period;
    if (smoothedTR === 0) return null;
    dxSeries.push(computeDX(smoothedPlusDM, smoothedMinusDM, smoothedTR));
  }

  // 5. ADX = Wilder-smoothed DX over `period` bars.
  //    With highs.length >= 2*period + 1, trs has >= 2*period entries and
  //    dxSeries has >= period entries — enough to seed the ADX average.
  if (dxSeries.length < period) return null;
  let adxVal = 0;
  for (let i = 0; i < period; i++) adxVal += dxSeries[i];
  adxVal /= period;
  for (let i = period; i < dxSeries.length; i++) {
    adxVal = ((period - 1) * adxVal + dxSeries[i]) / period;
  }
  return adxVal;
}
