/** OHLCV candle — superset of the detector `Candle` (adds volume for features). */
export interface OhlcvCandle {
  time: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type PatternOutcomeName = 'WIN' | 'LOSS' | 'TIMEOUT' | 'PENDING';

/** ATR-follow-through label parameters. */
export interface FollowThroughParams {
  /** favorable move required, in ATR multiples. */
  k: number;
  /** adverse move that fails the pattern, in ATR multiples. */
  m: number;
  /** horizon in bars. */
  n: number;
}

export const DEFAULT_FT_PARAMS: FollowThroughParams = { k: 1.5, m: 1.0, n: 10 };

export interface FollowThroughResult {
  outcome: PatternOutcomeName;
  /** WIN=1, LOSS=0, null for TIMEOUT/PENDING. */
  label: 0 | 1 | null;
  /** index where WIN/LOSS was decided; null otherwise. */
  resolvedIndex: number | null;
}

/** A row ready to persist to `pattern_observations`. */
export interface PatternObservationInput {
  token: string;
  exchange: string;
  timeframe: string;
  patternName: string;
  category: 'CANDLESTICK' | 'CHART';
  bias: 'BULLISH' | 'BEARISH';
  barTime: Date;
  candleWindow: OhlcvCandle[];
  atrAtDetection: number;
  outcome: PatternOutcomeName;
  label: 0 | 1 | null;
}
