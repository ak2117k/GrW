import { futuresReading, oiCheck, verdictOf, type OiCheckInput, type OiVerdict } from '../../signal-trader/domain/oi-check';
import { ENTRY_ENGINE, oiReading, type Bar1m, type ComponentLean, type Direction, type NewsReading, type OiReading, type TrendReading } from './entry-decision';

/**
 * Glue between the data and the decision, shared by the live service and the replay so both read the
 * same way. Pure.
 */

/** The universe of stage 1 (fixed): index options on NFO / BFO and crude on MCX. NFO stocks: not yet. */
export const ENGINE_UNIVERSE = Object.freeze(['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL'] as const);
export type EngineUnderlying = (typeof ENGINE_UNIVERSE)[number];

/** The evaluation window (IST minutes after midnight): 09:20–23:00. */
export const ENGINE_WINDOW = Object.freeze({ fromMin: 9 * 60 + 20, toMin: 23 * 60 });

const MIN = 60_000;

/** IST midnight of `at`'s IST day plus `minutes`. */
export function istDayAt(at: Date, minutes: number): Date {
  const ymd = new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return new Date(new Date(`${ymd}T00:00:00+05:30`).getTime() + minutes * MIN);
}

/** IST minutes after midnight. */
export function istMinutes(at: Date): number {
  const d = new Date(at.getTime() + 5.5 * 3_600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** The venue session's open on `at`'s IST day: MCX 09:00, NSE / NFO / BFO 09:15. */
export function sessionStartOf(optionExchange: string, at: Date): Date {
  return istDayAt(at, String(optionExchange).toUpperCase() === 'MCX' ? 9 * 60 : 9 * 60 + 15);
}

/**
 * The 1-minute bars the trend reads: the hub's candles_1m when it has the session (≥ the trend's
 * minimum), else the legacy `candles` 1m table for the same instrument (prod 2026-10-29: the crude
 * future had no candles_1m rows at all, only `candles`).
 */
export function chooseBars(hub: readonly Bar1m[], table: readonly Bar1m[], sessionStart: Date, at: Date): { bars: Bar1m[]; source: 'candles_1m' | 'candles' | 'none' } {
  const inSession = (xs: readonly Bar1m[]) => xs.filter((b) => b.ts >= sessionStart.getTime() && b.ts + MIN <= at.getTime()).length;
  if (inSession(hub) >= ENTRY_ENGINE.trendMinSessionBars) return { bars: [...hub], source: 'candles_1m' };
  if (inSession(table) >= ENTRY_ENGINE.trendMinSessionBars) return { bars: [...table], source: 'candles' };
  return { bars: hub.length >= table.length ? [...hub] : [...table], source: hub.length || table.length ? (hub.length >= table.length ? 'candles_1m' : 'candles') : 'none' };
}

/** The direction to ask OI about: the news lean, else the trend lean, else BULLISH (recorded only). */
export function wantFor(news: Pick<NewsReading, 'lean'>, trend: Pick<TrendReading, 'lean'>): Direction {
  const d = (l: ComponentLean): Direction | null => (l === 'BULLISH' || l === 'BEARISH' ? l : null);
  return d(news.lean) ?? d(trend.lean) ?? 'BULLISH';
}

/** Futures buildup alone (NFO near-month future): NO_DATA when not captured (MCX futures OI is not). */
export function futuresOnlyVerdict(input: OiCheckInput): OiVerdict {
  const f = futuresReading(input);
  if (!f) return 'NO_DATA';
  return verdictOf(input.want, [f.windows.ago?.lean ?? null, f.windows.open?.lean ?? null]);
}

/** The OI component: oiCheck (chain first, then futures) + the futures-only verdict. Never throws. */
export function readOi(input: OiCheckInput): OiReading {
  const check = oiCheck(input);
  let fut: OiVerdict = 'NO_DATA';
  try {
    fut = futuresOnlyVerdict(input);
  } catch {
    fut = 'NO_DATA';
  }
  return oiReading(check, fut);
}
