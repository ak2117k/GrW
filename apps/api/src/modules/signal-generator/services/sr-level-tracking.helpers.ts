import type { EvidenceLevel } from '../types/evidence-level.types';

/**
 * Minimal candle shape needed to classify a level's reaction. The Angel
 * historical adapter returns `{ timestamp, open, high, low, close, volume }`;
 * only high/low/close matter here, so callers map down to this.
 */
export interface ReactionCandle {
  high: number;
  low: number;
  close: number;
}

export type Reaction = 'UNTOUCHED' | 'REJECTED' | 'BROKE';

export interface ReactionDetail {
  /** Half-width of the level zone used for touch/break decisions (price units). */
  tol: number;
  /** Index of the first candle that entered the level zone, or null. */
  touchedIndex: number | null;
  /** A candle closed beyond the level by >= tol in the breaking direction. */
  decisiveBreak: boolean;
  /** Furthest move (price units) in the level-defending direction after touch. */
  defendExcursion: number;
  /** Furthest close beyond the level (price units) in the breaking direction. */
  breakExcursion: number;
  /** Candles considered (touch onward). */
  candlesEvaluated: number;
  /** Touched but neither cleanly defended (>=tol) nor decisively broke. */
  ambiguous?: boolean;
}

export interface ReactionResult {
  touched: boolean;
  reaction: Reaction;
  detail: ReactionDetail;
}

/**
 * Tolerance band half-width for a level: the larger of 0.3*ATR14 and 0.3% of
 * price. ATR adapts the band to the instrument's volatility; the pct floor
 * keeps it sane when ATR is missing/tiny (e.g. illiquid names or no atr14).
 */
export function reactionTolerance(price: number, atr14: number | null | undefined): number {
  const atrBand = 0.3 * (Number.isFinite(atr14 as number) ? (atr14 as number) : 0);
  const pctFloor = 0.003 * price;
  return Math.max(atrBand, pctFloor);
}

/**
 * Classify how price reacted to an S/R level over the candles that followed
 * the snapshot. PURE — no broker/DB — so it is unit-testable in isolation.
 *
 * Definitions (tol = {@link reactionTolerance}):
 * - UNTOUCHED: no candle's range ever entered the zone [price-tol, price+tol].
 * - BROKE: once touched, a candle CLOSED beyond the level by >= tol in the
 *   breaking direction (below for support, above for resistance). Takes
 *   precedence — a decisive close-through means the level ultimately failed,
 *   even if price defended it earlier in the window.
 * - REJECTED: touched and the level held. Cleanly held if price moved >= tol
 *   away in the defending direction (up for support, down for resistance).
 *   Touched-but-undecided (no decisive break, no >=tol move-away) is also
 *   REJECTED but flagged `detail.ambiguous` so calibration can exclude it.
 */
export function classifyReaction(
  level: EvidenceLevel,
  subsequentCandles: ReactionCandle[],
  atr14: number | null | undefined,
): ReactionResult {
  const { price, side } = level;
  const tol = reactionTolerance(price, atr14);
  const upper = price + tol;
  const lower = price - tol;

  // First touch: candle range intersects the zone [lower, upper].
  let touchedIndex: number | null = null;
  for (let i = 0; i < subsequentCandles.length; i++) {
    const k = subsequentCandles[i];
    if (k.low <= upper && k.high >= lower) {
      touchedIndex = i;
      break;
    }
  }

  if (touchedIndex === null) {
    return {
      touched: false,
      reaction: 'UNTOUCHED',
      detail: {
        tol,
        touchedIndex: null,
        decisiveBreak: false,
        defendExcursion: 0,
        breakExcursion: 0,
        candlesEvaluated: 0,
      },
    };
  }

  const window = subsequentCandles.slice(touchedIndex);
  const isSupport = side === 'support';

  let decisiveBreak = false;
  let breakExcursion = 0;
  let defendExcursion = 0;

  for (const k of window) {
    if (isSupport) {
      // Break = close decisively below; defend = high pushing back up.
      if (k.close <= lower) {
        decisiveBreak = true;
        breakExcursion = Math.max(breakExcursion, price - k.close);
      }
      defendExcursion = Math.max(defendExcursion, k.high - price);
    } else {
      // Resistance: break = close decisively above; defend = low falling away.
      if (k.close >= upper) {
        decisiveBreak = true;
        breakExcursion = Math.max(breakExcursion, k.close - price);
      }
      defendExcursion = Math.max(defendExcursion, price - k.low);
    }
  }

  let reaction: Reaction;
  let ambiguous: boolean | undefined;
  if (decisiveBreak) {
    reaction = 'BROKE';
  } else if (defendExcursion >= tol) {
    reaction = 'REJECTED';
  } else {
    // Touched, no decisive break, no clean >=tol move-away: it held but the
    // bounce was shallow. Count as held (REJECTED) but flag ambiguity.
    reaction = 'REJECTED';
    ambiguous = true;
  }

  return {
    touched: true,
    reaction,
    detail: {
      tol,
      touchedIndex,
      decisiveBreak,
      defendExcursion,
      breakExcursion,
      candlesEvaluated: window.length,
      ...(ambiguous ? { ambiguous: true } : {}),
    },
  };
}
