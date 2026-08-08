export type LevelType =
  | 'PDH' | 'PDL'
  | 'ORH' | 'ORL'
  | 'VWAP'
  | 'ROUND'
  | 'VOL_STRIKE'
  | 'STRONG_ZONE';

/**
 * Tier label assigned to each context-scoring factor + the combined
 * context score. NEUTRAL_STUB is used ONLY for per-factor results when
 * the factor's implementation isn't ready yet — it never appears on the
 * combined `contextTier` (which always derives from the aggregated
 * numeric score).
 *
 * Defined here (rather than in the context-scoring module) so SetupContext
 * fields can reference these types without creating a circular dependency
 * between setup-context.types and context-scoring/types.
 */
export type Tier =
  | 'STRONG_BULL'
  | 'BULL'
  | 'NEUTRAL'
  | 'BEAR'
  | 'STRONG_BEAR'
  | 'NEUTRAL_STUB';

/** Subset of Tier valid for the combined contextTier — never NEUTRAL_STUB. */
export type CombinedTier = Exclude<Tier, 'NEUTRAL_STUB'>;

export interface ContextFactorBreakdown {
  name: string;
  weight: number;
  tier: Tier;
  value: number;
  contribution: number;
  isStub: boolean;
  detail?: Record<string, unknown>;
}

/** Tier derivation from per-factor value (-1.0 to +1.0). */
export function tierFromValue(value: number): Tier {
  if (value >= 0.6) return 'STRONG_BULL';
  if (value >= 0.2) return 'BULL';
  if (value <= -0.6) return 'STRONG_BEAR';
  if (value <= -0.2) return 'BEAR';
  return 'NEUTRAL';
}

/** Tier derivation from combined score (-100 to +100). */
export function tierFromScore(score: number): CombinedTier {
  if (score >= 60) return 'STRONG_BULL';
  if (score >= 20) return 'BULL';
  if (score <= -60) return 'STRONG_BEAR';
  if (score <= -20) return 'BEAR';
  return 'NEUTRAL';
}

export type SetupType = 'BREAKOUT' | 'REVERSAL';

export type SetupGrade = 'A' | 'B' | 'C';

export type TimeOfDayWindow = 'morning-trend' | 'afternoon-trend';

/**
 * Daily regime classification — drives per-setup-type bias in gradeSetup
 * and the regime-mismatch reject gate. Computed once per analyze() call
 * from the LevelBook (todayHigh/todayLow vs atr14).
 */
export type Regime = 'trending' | 'choppy' | 'normal';

export interface IndicatorReadings {
  ema9: number | null;
  ema21: number | null;
  rsi14: number | null;
  macdHistogram: number | null;     // signed; positive = bullish
  bollingerPosition: number | null; // -1 to +1, where price sits relative to bands (0 = middle)
  roc10: number | null;             // percentage
  /** Per-indicator alignment with the setup direction: 1 = aligned, -1 = opposed, 0 = neutral. */
  alignment: {
    ema: 1 | 0 | -1;
    rsi: 1 | 0 | -1;
    macd: 1 | 0 | -1;
    bollinger: 1 | 0 | -1;
    momentum: 1 | 0 | -1;
  };
  /** Sum of alignment values (-5 to +5). For BUY, +5 means all bullish; for SELL, +5 means all bearish (alignment is computed in the SETUP direction). */
  agreement: number;
}

export interface SetupContext {
  levelType: LevelType;
  setupType: SetupType;
  levelValue: number;
  grade: SetupGrade;

  entry: number;
  stoploss: number;
  target: number;
  /** Price at which 50% of the position is booked (1×SL distance in profit). */
  partialTakeAt: number;

  triggerCandle: {
    time: number; // unix seconds
    ohlc: [number, number, number, number]; // open, high, low, close
  };

  levelBookSnapshot: {
    pdh: number;
    pdl: number;
    orh: number | null;
    orl: number | null;
    vwap: number;
    todayHigh: number;
    todayLow: number;
  };

  atr14: number;
  /**
   * Traded volume of the trigger bar over its VMA20 — or, for an index
   * (whose candles carry no volume), total option-chain traded volume over
   * its own 20-period average.
   *
   * Tri-state: a number is a real measurement (including a genuine 0);
   * `null` means NO READING EXISTS and the volume factor was skipped at
   * both the breakout gate and the grade. Never conflate the two — a 0
   * asserts "volume disconfirmed this trade", which is a lie on an
   * instrument with no volume to read.
   * See docs/superpowers/specs/2026-08-07-trade-plan-design.md §3.4.
   */
  volumeRatio: number | null;
  timeOfDayWindow: TimeOfDayWindow;
  indicators: IndicatorReadings;
  /**
   * Higher-timeframe trend bias snapshot used by the MTF gate. Computed by
   * SignalGeneratorService from the closed bar of the next-higher TF (e.g.
   * 1H when working on 15m). Null when the working TF has no defined
   * higher TF (e.g. 1d) or when not enough higher-TF candles were
   * available to compute it.
   */
  higherTimeframeTrend: {
    tf: string;
    ema9: number;
    ema21: number;
    bias: 'bullish' | 'bearish' | 'neutral';
  } | null;
  /**
   * Daily regime classification. Null when not computed (defensive — legacy
   * callers without LevelBook range/ATR data). Drives the per-setup-type
   * bias applied in gradeSetup() and the regime-mismatch reject gate.
   */
  regime: Regime | null;
  /** intradayRange / atr14 — diagnostic ratio backing the regime label. */
  intradayRangeRatio: number;
  expiryDayWarning?: boolean;
  /**
   * How TP1 (`partialTakeAt`) was placed:
   *   'fixed'    → entry ± 1×R (the historical default)
   *   'obstacle' → near edge of a STRONG/MEDIUM zone (touchCount ≥ 3) in
   *                the trade path, with a 0.1×ATR buffer.
   *
   * Optional so persisted setups from before this field existed still
   * rehydrate cleanly (Prisma column is `Json?`).
   */
  tp1Source?: 'obstacle' | 'fixed';
  /**
   * Metadata about the obstacle that drove TP1 placement, populated only
   * when `tp1Source === 'obstacle'`. Surfaces in the AnalysisPanel TP1 row
   * so the trader can see WHY TP1 sits where it does.
   */
  tp1Obstacle?: {
    classification: 'STRONG' | 'MEDIUM';
    touchCount: number;
    /** The band edge price hits FIRST in the trade direction (upper for SELL, lower for BUY). */
    nearEdge: number;
  } | null;

  // ──────────────────────────────────────────────────────────────────
  // Context scoring (Mama's 10-factor framework). All optional — older
  // persisted setups (Prisma `Json?`) still rehydrate cleanly without
  // these fields, and analyze() may omit them on legacy code paths.
  // ──────────────────────────────────────────────────────────────────

  /** Aggregated alignment score, -100 (counter) to +100 (supportive of side). */
  contextScore?: number;
  /** Tier label derived from contextScore. Never `NEUTRAL_STUB`. */
  contextTier?: CombinedTier;
  /** Real-factor weight coverage, 0.0 to 1.0 — share of weight from non-stub factors. */
  contextCoverage?: number;
  /** Per-factor breakdown (name, weight, tier, value, contribution, isStub). */
  contextFactors?: ContextFactorBreakdown[];

  /**
   * Optional reference to the locked option-strike recommendation, attached
   * to the SetupContext just before scoring runs so factors like
   * `GreeksFactor` can read delta / gamma without an extra injection.
   * Structurally-typed (just the fields scoring cares about) so the strike
   * type from `setup-tracker.service` can be assigned in without a
   * circular import — extra fields on the actual RecommendedStrike are
   * accepted via TypeScript's excess-property tolerance for assignment.
   */
  recommendedStrike?: {
    strike: number;
    side: 'CE' | 'PE';
    delta: number;
    gamma: number;
  } | null;
}
