/** Chart timeframes the CandleStore serves (the strings the web client sends). */
export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '1d' | '1w' | '1mo';
const TIMEFRAMES: ReadonlySet<string> = new Set<Timeframe>(['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1mo']);
export function isTimeframe(x: string): x is Timeframe {
  return TIMEFRAMES.has(x);
}

/** The three stored series. */
export type CandleTable = '1m' | '1h' | '1d';

/** One bar. `ts` = bar start, ms epoch. Volume is the bar's own volume (never cumulative). */
export interface HubCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
}

export type BrokerInterval = 'ONE_MINUTE' | 'ONE_HOUR' | 'ONE_DAY';

/** Why a range is missing from a result. `deferred` = being filled in the background. */
export type IncompleteReason = 'throttled' | 'busy' | 'error' | 'deferred';
/** Half-open [from, to), ms epoch. */
export interface IncompleteRange {
  from: number;
  to: number;
  reason: IncompleteReason;
}

export interface CandlesResult {
  candles: HubCandle[];
  incomplete: IncompleteRange[];
}

/** Which stored series a timeframe reads (1h's history; today's 1h comes from 1m). */
export const BASE_TABLE: Record<Timeframe, CandleTable> = {
  '1m': '1m', '5m': '1m', '15m': '1m', '30m': '1m', '1h': '1h', '1d': '1d', '1w': '1d', '1mo': '1d',
};

/** Bucket width when a timeframe is grouped from 1-minute bars. */
export const STEP_MIN: Record<'5m' | '15m' | '30m' | '1h', number> = { '5m': 5, '15m': 15, '30m': 30, '1h': 60 };

export const TABLE_BAR_MIN: Record<CandleTable, number> = { '1m': 1, '1h': 60, '1d': 1440 };
export const TABLE_INTERVAL: Record<CandleTable, BrokerInterval> = { '1m': 'ONE_MINUTE', '1h': 'ONE_HOUR', '1d': 'ONE_DAY' };
/** Days per getCandleData call (Angel silently truncates wider sub-hour windows). */
export const TABLE_MAX_DAYS: Record<CandleTable, number> = { '1m': 1, '1h': 365, '1d': 1800 };

/**
 * How far back a read based on candles_1m may reach (1m/5m/15m/30m, and today's part of
 * 1h/1d). Equals the candles_1m retention policy in deploy/sql/candles-timescale.sql: older
 * minutes are dropped, so a fill there would be thrown away again.
 */
export const ONE_MINUTE_HORIZON_DAYS = 180;
/** Background fills one read may queue. Further windows are reported `deferred` but not queued. */
export const MAX_DEFERRED_PER_READ = 30;
