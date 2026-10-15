import { ATR_PERIOD } from './config';
import type { MinuteBar, NoiseReading } from './types';

/**
 * Below this many valid bars there is no noise unit (null ⇒ the fixed floor and the
 * 40 % giveback, exactly as with discipline off). One to four bars can give an N of
 * a tick or two, which would arm a "noise" floor ticks below the peak and keep it
 * there (the floor only tightens).
 */
export const MIN_NOISE_BARS = 5;

const ok = (b: MinuteBar) =>
  [b.ts, b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x)) && b.low > 0 && b.high >= b.low;

/** R2. The caller chooses the window (last NOISE_LOOKBACK_MIN minutes of the IST day). */
export function noiseFromBars(input: MinuteBar[]): NoiseReading | null {
  const bars = input.filter(ok).sort((a, b) => a.ts - b.ts);
  if (bars.length < MIN_NOISE_BARS) return null;
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

/** Session length used to scale a DAILY ATR to one minute when the caller does not know the exchange. */
export const DEFAULT_SESSION_MINUTES = 375;

/**
 * R3 fallback: the underlying's level-book ATR14 scaled to one minute. The level book's `atr14` is
 * computed from DAILY candles (LevelBookService.seedSession) even though the book's `interval` says
 * 15m — so it scales by √(session minutes), not √15 (which overstated MCX crude ~8x: 81.7 vs ~10.7).
 */
export function scaledUnderlyingNoise(
  atrDaily: number | null | undefined,
  at: string,
  sessionMinutes: number = DEFAULT_SESSION_MINUTES,
): NoiseReading | null {
  const minutes = Number.isFinite(sessionMinutes) && sessionMinutes > 0 ? sessionMinutes : DEFAULT_SESSION_MINUTES;
  return typeof atrDaily === 'number' && Number.isFinite(atrDaily) && atrDaily > 0
    ? { n: atrDaily / Math.sqrt(minutes), method: 'atr14-daily-scaled', bars: 0, at }
    : null;
}
