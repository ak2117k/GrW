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

/**
 * Only bars inside the exchange's continuous session (IST). Prod 2026-11-05: candles_1m holds NSE PRE-OPEN index
 * bars 09:00–09:14 (the 09:00 bar spanned NIFTY 23,608–24,580), which tripled the morning noise unit for every
 * rule until they rolled out of the 120-min window (~11:15). NSE / NFO / BSE / BFO 09:15–15:30; MCX 09:00–23:55;
 * an unknown exchange keeps every bar (as before).
 */
export function sessionBarsOnly(bars: MinuteBar[], exchange: string | null | undefined): MinuteBar[] {
  const ex = String(exchange ?? '').toUpperCase();
  const win = ['NSE', 'NFO', 'BSE', 'BFO'].includes(ex) ? [555, 930] : ex.startsWith('MCX') ? [540, 1435] : null;
  if (!win) return bars;
  return bars.filter((b) => {
    if (!Number.isFinite(b.ts)) return false;
    const ist = new Date(b.ts + 5.5 * 3_600_000);
    const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return m >= win[0] && m < win[1];
  });
}

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
