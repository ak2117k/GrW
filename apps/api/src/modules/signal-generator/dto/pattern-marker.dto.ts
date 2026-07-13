/**
 * Wire contract for the GET /api/signals/patterns endpoint.
 *
 * A `PatternMarkerDto` is a flattened, frontend-friendly projection of the two
 * detector shapes (`CandlestickPattern` and `ChartPattern`). Both collapse into
 * one marker type so the chart overlay can render every hit uniformly. Fields
 * that only make sense for one category are `null` for the other (documented
 * inline). A parallel frontend agent builds against this exact contract — keep
 * it stable.
 */
export interface PatternMarkerDto {
  category: 'CANDLESTICK' | 'CHART';
  name: string; // e.g. 'BULLISH_ENGULFING' | 'DOUBLE_TOP'
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** epoch MS of the ANCHOR candle (candlestick: the signal candle; chart: the SECOND peak/trough). */
  time: number;
  /** CHART: [firstPeakMs, secondPeakMs]; CANDLESTICK: []. */
  points: number[];
  /** CHART only, else null. */
  necklinePrice: number | null;
  /** CHART only, else null. */
  confirmed: boolean | null;
  /** epoch MS of the confirming candle, else null. */
  confirmTime: number | null;
}

export interface PatternsResponseDto {
  symbol: string;
  timeframe: string;
  count: number;
  patterns: PatternMarkerDto[];
}
