import { ATR_PERIOD } from './config';
import type { MinuteBar, NoiseReading } from './types';

const ok = (b: MinuteBar) =>
  [b.ts, b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x)) && b.low > 0 && b.high >= b.low;

/** R2. The caller chooses the window (last NOISE_LOOKBACK_MIN minutes of the IST day). */
export function noiseFromBars(input: MinuteBar[]): NoiseReading | null {
  const bars = input.filter(ok).sort((a, b) => a.ts - b.ts);
  if (bars.length === 0) return null;
  const at = new Date(bars[bars.length - 1].ts + 60_000).toISOString();
  if (bars.length >= ATR_PERIOD) {
    const tr = bars.map((b, i) => (i === 0 ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
    const last = tr.slice(-ATR_PERIOD);
    const n = last.reduce((s, x) => s + x, 0) / ATR_PERIOD;
    return n > 0 ? { n, method: 'atr14-1m', bars: bars.length, at } : null;
  }
  const n = (Math.max(...bars.map((b) => b.high)) - Math.min(...bars.map((b) => b.low))) / Math.sqrt(bars.length);
  return n > 0 ? { n, method: 'range-sqrt-1m', bars: bars.length, at } : null;
}

/** R3 fallback: the underlying's 15m level-book ATR14 scaled to one minute. */
export function scaledUnderlyingNoise(atr15m: number | null | undefined, at: string): NoiseReading | null {
  return typeof atr15m === 'number' && Number.isFinite(atr15m) && atr15m > 0
    ? { n: atr15m / Math.sqrt(15), method: 'atr14-15m-scaled', bars: 0, at }
    : null;
}
