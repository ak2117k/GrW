/**
 * Hardcoded weights for the v1 context-scoring engine. Sum = 1.00.
 * Source: spec §"Weights (v1)" — Mama's prioritization, refined for
 * the existing setup pipeline (low explicit weight on greeks because
 * they already drive the option-strike picker).
 *
 * Tunable later via Settings if real-data calibration suggests it.
 */
export const FACTOR_WEIGHTS = {
  mtfTrend:   0.20,
  sector:     0.15,
  fii:        0.15,
  oiShift:    0.15,
  volatility: 0.10,
  nasdaq:     0.10,
  greeks:     0.05,
  crudeOil:   0.05,
  gold:       0.05,
} as const;

export type FactorName = keyof typeof FACTOR_WEIGHTS;
