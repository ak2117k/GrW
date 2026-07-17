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

/**
 * Bucket-A context captured AT the detection bar (external market state the
 * candle window does not hold). Only trustworthy when captured at the live edge
 * — the context services are as-of-now only — so it is null for backfill and
 * chart-load rows. Each sub-object is independently nullable: one failing service
 * nulls only its own slice, never the whole snapshot (fail-open per signal).
 * Versioned via `v` so Python can interpret older snapshots as the shape evolves.
 * See docs/superpowers/specs/2026-07-17-ml-detection-context-enrichment-design.md.
 */
export interface DetectionContext {
  v: 1;
  /** Higher-timeframe (MTF) alignment at detection. */
  mtf: { aligned: boolean; direction: 'UP' | 'DOWN' | null } | null;
  /** Proximity to the nearest S/R level, distance in ATR units. */
  sr: { distanceAtr: number; atLevel: boolean } | null;
  /** Sector-index trend and whether it agrees with the pattern's bias. */
  sector: { trend: 'UP' | 'DOWN' | 'NEUTRAL' | null; alignment: 'with' | 'against' | 'neutral' } | null;
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
  /**
   * Bucket-A external context, captured only at the live edge (scan path). Absent
   * / null for chart-load capture and backfill. Persisted to the nullable
   * `detectionContext` JSON column.
   */
  detectionContext?: DetectionContext | null;
}
