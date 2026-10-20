/** Plain indicator math over closes (oldest first). Pure; null when there is not enough history. */

export function emaSeries(values: readonly number[], period: number): number[] {
  if (values.length < period || period < 1) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period; // SMA seed
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function lastEma(values: readonly number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

/** MACD(12,26,9) histogram, last two values (for sign and slope). */
export function macdHistogram(values: readonly number[]): { hist: number; prevHist: number } | null {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  if (slow.length < 10) return null;
  // Align: slow[i] corresponds to values[i + 25]; fast[j] to values[j + 11].
  const macd = slow.map((s, i) => fast[i + 14] - s);
  const signal = emaSeries(macd, 9);
  if (signal.length < 2) return null;
  const n = macd.length;
  const m = signal.length;
  return { hist: macd[n - 1] - signal[m - 1], prevHist: macd[n - 2] - signal[m - 2] };
}

/** Wilder RSI(14). */
export function rsi(values: readonly number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
