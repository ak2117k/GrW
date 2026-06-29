/**
 * Pure order-ticket math. No React, no I/O — everything here is a deterministic
 * function of its inputs so it can be unit-tested in isolation and reused by the
 * presentational leaves (CapitalStrip, RiskRewardBar) without re-deriving logic.
 */

export type OrderSide = 'BUY' | 'SELL';

export interface RiskRewardInput {
  entry: number;
  sl?: number;
  target?: number;
  qty: number;
  side: OrderSide;
}

export interface RiskRewardResult {
  /** ₹ at risk if SL is hit (clamped to >= 0 for display). */
  riskAmt: number;
  /** ₹ gained if target is hit (clamped to >= 0 for display). */
  rewardAmt: number;
  /** reward / risk, or null when either leg is absent/zero. */
  rr: number | null;
  /** |entry - sl| / entry * 100, or null when SL absent / entry <= 0. */
  slPct: number | null;
  /** |target - entry| / entry * 100, or null when target absent / entry <= 0. */
  tgtPct: number | null;
}

/**
 * Order notional value. Guards against negative/zero inputs so the ticket never
 * shows a negative estimate (e.g. a half-typed price).
 */
export function estimatedValue(qty: number, entryPrice: number): number {
  if (qty <= 0 || entryPrice <= 0) return 0;
  return qty * entryPrice;
}

/**
 * How many whole units the remaining capital can buy at the given price.
 * Never negative; 0 when price is non-positive (avoids divide-by-zero / Infinity).
 */
export function maxAffordable(remaining: number, entryPrice: number): number {
  if (entryPrice <= 0) return 0;
  const n = Math.floor(remaining / entryPrice);
  return n > 0 ? n : 0;
}

/**
 * Risk/reward preview for a single leg.
 *
 * BUY:  risk = (entry - sl) * qty,  reward = (target - entry) * qty
 * SELL: risk = (sl - entry) * qty,  reward = (entry - target) * qty
 *
 * riskAmt/rewardAmt are clamped to >= 0 for display (a "SL above entry" on a BUY
 * is nonsensical risk, so it reads 0 rather than a negative). rr is null unless
 * both legs are strictly positive. Percentages are null when the leg is absent
 * or entry is non-positive.
 */
export function riskReward({
  entry,
  sl,
  target,
  qty,
  side,
}: RiskRewardInput): RiskRewardResult {
  const hasSl = sl !== undefined && sl !== null && !Number.isNaN(sl);
  const hasTarget =
    target !== undefined && target !== null && !Number.isNaN(target);

  let rawRisk = 0;
  let rawReward = 0;

  if (hasSl) {
    rawRisk = side === 'BUY' ? (entry - (sl as number)) * qty : ((sl as number) - entry) * qty;
  }
  if (hasTarget) {
    rawReward =
      side === 'BUY' ? ((target as number) - entry) * qty : (entry - (target as number)) * qty;
  }

  const riskAmt = rawRisk > 0 ? rawRisk : 0;
  const rewardAmt = rawReward > 0 ? rawReward : 0;

  const rr = riskAmt > 0 && rewardAmt > 0 ? rewardAmt / riskAmt : null;

  const slPct =
    hasSl && entry > 0 ? (Math.abs(entry - (sl as number)) / entry) * 100 : null;
  const tgtPct =
    hasTarget && entry > 0
      ? (Math.abs((target as number) - entry) / entry) * 100
      : null;

  return { riskAmt, rewardAmt, rr, slPct, tgtPct };
}
