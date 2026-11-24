import { heikinCloses, lastEma, macdHistogram } from '../../overnight-scorecard/domain/indicators';
import { istDayOf, sessionOnlyBars, venueSession } from '../../exit-discipline/session-bars';
import { directionOf } from '../../signal-intake/domain/types';
import type { InstrumentKind, Side } from './signal.types';

/**
 * WITH / AGAINST the trend, for every incoming signal. RECORD ONLY: nothing in the gate, the sizing,
 * the judge's verdict rules or the exits reads it (owner 2026-11-10). Stored on signal_decisions.trend
 * and shown to the AI judge as market.trend, so the night review can split results by it.
 *
 * The trend is the overnight scorecard's own 15-minute timeframe call (overnight-scorecard/domain/factors
 * timeframeVote, the definition the owner's EMA 20/80 backtest used — with-trend calls averaged
 * +₹717 a trade, against-trend −₹1,646): Heikin Ashi closes of the underlying's 15m bars, EMA20 vs EMA80
 * and the MACD(12,26,9) histogram's sign. Up = EMA20 > EMA80; the signal's want is its market view
 * (BUY CE / SELL PE / BUY FUT / BUY EQ = bullish; signal-intake directionOf).
 *
 *   WITH    — both the EMA alignment and the histogram agree with the signal's direction
 *   AGAINST — both disagree
 *   MIXED   — they disagree with each other (or one of them is exactly flat)
 *   UNKNOWN — fewer than {@link TREND_MIN_BARS} completed 15m bars
 *
 * SESSION BARS ONLY (2026-11-24): given the price line's `exchange`, only 15m buckets that START inside the venue's
 * session and on its grid are read (exit-discipline/session-bars: NSE/BSE 09:15–15:30, MCX 09:00–23:55). Prod 2026-11-23:
 * the unfiltered BANKNIFTY 09:00 bucket was the NSE pre-open auction (a 1,100-pt range that never traded) and, before
 * 09:30, the tag's newest "closed" bar (decision rows at 09:21 and 09:28 had lastBarAt 09:00); flat off-hours buckets
 * (from ~02:00 and after 15:30) diluted the EMAs every day. Before today's first session bar has closed (NSE
 * 09:15–09:30) the reading is the previous session's closed bars: `note` says so and `lastBarAt` is that session's
 * last bar; with too few of them it is UNKNOWN with the reason 'no closed session 15m bar yet'.
 */
export type TrendTag = 'WITH' | 'AGAINST' | 'MIXED' | 'UNKNOWN';

export const TREND_TIMEFRAME = '15m';
/** The scorecard's floor for its 15m call (factors DAILY_MIN_BARS): EMA80 plus its run-in. */
export const TREND_MIN_BARS = 120;
/** Bars read (newest first) — the scorecard reads 300; more only lengthens the EMA run-in. */
export const TREND_MAX_BARS = 300;

export interface TrendBar {
  /** Bucket start, epoch ms. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TrendRecord {
  tag: TrendTag;
  /** The signal's market view (signal-intake directionOf). */
  direction: 'BULL' | 'BEAR';
  /** UP / DOWN when EMA and MACD agree with each other, else MIXED; null with too few bars. */
  trend: 'UP' | 'DOWN' | 'MIXED' | null;
  ema20: number | null;
  ema80: number | null;
  macdHist: number | null;
  timeframe: typeof TREND_TIMEFRAME;
  price: 'heikin-ashi close';
  candleCount: number;
  /** Start of the newest completed bar used (ISO), null when there were none. */
  lastBarAt: string | null;
  computedAt: string;
  /** Where the bars came from (e.g. "candles_1m NIFTY 50 → 15m"). */
  source: string;
  /** Why the tag is UNKNOWN. */
  reason?: string;
  /** Set when today's session has no closed 15m bar yet: the reading is from the previous session's bars. */
  note?: string;
}

const r4 = (v: number | null) => (v === null ? null : Math.round(v * 10_000) / 10_000);
const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export const NO_SESSION_BAR_YET = 'no closed session 15m bar yet';

/**
 * Pure: the tag + the raw numbers from completed 15m bars (oldest first). With `exchange` (the UNDERLYING line's:
 * NSE/BSE for an index, MCX for a commodity future) off-session buckets are dropped first (see the header).
 */
export function classifyTrend(i: { kind: InstrumentKind; side: Side; bars: readonly TrendBar[]; now: Date; source: string; exchange?: string | null }): TrendRecord {
  const direction = directionOf(i.kind, i.side);
  const session = i.exchange ? venueSession(i.exchange) : null;
  const bars = (session ? sessionOnlyBars(i.bars, i.exchange, 15) : [...i.bars]).slice(-TREND_MAX_BARS);
  const noTodayBar = session !== null && !bars.some((b) => istDayOf(b.ts) === istDayOf(i.now.getTime()));
  const base = {
    direction,
    timeframe: TREND_TIMEFRAME as typeof TREND_TIMEFRAME,
    price: 'heikin-ashi close' as const,
    candleCount: bars.length,
    lastBarAt: bars.length ? new Date(bars[bars.length - 1].ts).toISOString() : null,
    computedAt: i.now.toISOString(),
    source: i.source,
  };
  const unknown = (reason: string): TrendRecord => ({ ...base, tag: 'UNKNOWN', trend: null, ema20: null, ema80: null, macdHist: null, reason });
  if (bars.length < TREND_MIN_BARS) {
    const few = `${bars.length} completed ${TREND_TIMEFRAME} bars, need ${TREND_MIN_BARS}`;
    return unknown(noTodayBar ? `${NO_SESSION_BAR_YET} (${few})` : few);
  }
  const note = noTodayBar ? `${NO_SESSION_BAR_YET} today — reading from the previous session's closed bars (lastBarAt)` : undefined;
  const closes = heikinCloses(bars);
  const e20 = lastEma(closes, 20);
  const e80 = lastEma(closes, 80);
  const m = macdHistogram(closes);
  if (e20 === null || e80 === null || m === null) return unknown('EMA20 / EMA80 / MACD not computable from the bars');
  const emaDir = sign(e20 - e80);
  const macdDir = sign(m.hist);
  const want = direction === 'BULL' ? 1 : -1;
  const tag: TrendTag = emaDir === want && macdDir === want ? 'WITH' : emaDir === -want && macdDir === -want ? 'AGAINST' : 'MIXED';
  const trend = emaDir !== 0 && emaDir === macdDir ? (emaDir > 0 ? 'UP' : 'DOWN') : 'MIXED';
  return { ...base, tag, trend, ema20: r4(e20), ema80: r4(e80), macdHist: r4(m.hist), ...(note ? { note } : {}) };
}

/**
 * Pure: one 15m series from the persisted `candles` 15m history (older) and the hub's candles_1m rolled
 * to 15m (newer). Where both have a bucket the hub's wins; only bars that have CLOSED by `now` are kept
 * (a forming bar would make the tag flicker within the quarter-hour).
 */
export function mergeTrendBars(older: readonly TrendBar[], hub: readonly TrendBar[], now: Date): TrendBar[] {
  const byTs = new Map<number, TrendBar>();
  for (const b of older) byTs.set(b.ts, b);
  for (const b of hub) byTs.set(b.ts, b);
  const doneBy = now.getTime() - 15 * 60_000;
  return [...byTs.values()]
    .filter((b) => b.ts <= doneBy && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.ts - b.ts);
}
