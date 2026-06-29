/**
 * Strong-zone reversal strategy — shared contract.
 *
 * See docs/superpowers/specs/2026-05-03-strong-zone-reversal-strategy-design.md
 * "Shared contract (locked)" section. Frontend mirrors this in
 * apps/web/src/types/index.ts. Field names, units, and value ranges
 * (e.g. 0-100 normalized scores) are part of the contract — do not
 * rename without updating both sides + the spec.
 */
export interface StrongZone {
  /** Stable id (token + zone center hash). */
  id: string;
  /** Instrument token. */
  token: string;
  symbol: string;
  exchange: string;
  type: 'support' | 'resistance';
  /** Zone top price. */
  upper: number;
  /** Zone bottom price (== upper if isLine). */
  lower: number;
  /** True = single horizontal line, false = band. */
  isLine: boolean;
  /** 0-100 normalized strength score. */
  strength: number;
  classification: 'STRONG' | 'MEDIUM' | 'WEAK';
  touchCount: number;
  /** Unix ms timestamp of the most recent touch. */
  lastTouchTimestamp: number;
  scoreBreakdown: ZoneScoreBreakdown;
  /** Unix ms when this zone was computed. */
  computedAt: number;
  /** Unix ms when this zone should be recomputed. */
  expiresAt: number;
  /**
   * Unix ms when an impulsive break of this zone was detected (close beyond
   * the wall edge by body > 0.5×ATR). When set, `type` reflects the
   * post-flip polarity, `wasType` carries the pre-flip polarity, and
   * `preFlipTouchCount` carries the touchCount before the half-credit
   * recomputation. All three are optional so persisted rows + tests +
   * older callers stay compatible — the JSON DB column accepts the
   * absence cleanly.
   */
  flippedAt?: number;
  wasType?: 'support' | 'resistance';
  preFlipTouchCount?: number;
}

/**
 * Per-dimension breakdown of the strength score. Each value is a
 * 0-100 normalized score; the final `strength` is a weighted sum
 * (weights documented in the spec, sum to 1.0).
 */
export interface ZoneScoreBreakdown {
  touchCount: number;
  reversalScore: number;
  volumeScore: number;
  recencyScore: number;
  confluenceBonus: number;
  wickDensity: number;
}
