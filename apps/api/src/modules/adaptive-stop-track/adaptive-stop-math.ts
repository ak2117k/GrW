import {
  ATR_MULT, MIN_STOP_PCT, MAX_STOP_PCT, RISK_PER_TRADE,
  TRAIL_ATR_MULT, TRAIL_MIN_PCT, TRAIL_MAX_PCT,
} from './constants';

export interface StopResolution { stopPrice: number; stopDist: number; stopPct: number; basis: 'atr' | 'floor' | 'cap'; }

/** Volatility stop: ATR_MULT×atr5m, floored at MIN_STOP_PCT and capped at MAX_STOP_PCT of entry. */
export function resolveStop(entry: number, atr5m: number): StopResolution {
  const minDist = (MIN_STOP_PCT / 100) * entry;
  const maxDist = (MAX_STOP_PCT / 100) * entry;
  const atrDist = Number.isFinite(atr5m) && atr5m > 0 ? ATR_MULT * atr5m : 0;
  let stopDist = atrDist;
  let basis: StopResolution['basis'] = 'atr';
  if (!(atrDist > 0) || atrDist < minDist) { stopDist = minDist; basis = 'floor'; }
  else if (atrDist > maxDist) { stopDist = maxDist; basis = 'cap'; }
  return { stopPrice: entry - stopDist, stopDist, stopPct: (stopDist / entry) * 100, basis };
}

export interface TrailResolution { stopPrice: number; trailDist: number; trailPct: number; basis: 'atr' | 'floor' | 'cap'; }

/**
 * Trailing give-back from the high-water price: TRAIL_ATR_MULT×atr5m, floored at
 * TRAIL_MIN_PCT and capped at TRAIL_MAX_PCT of the high-water. Replaces the flat
 * 0.5% give-back that stopped winners out on noise before they reached target.
 * `side` = 1 for BUY (stop below high-water), -1 for SELL (stop above).
 */
export function resolveTrail(highWater: number, atr5m: number, side: 1 | -1 = 1): TrailResolution {
  const minDist = (TRAIL_MIN_PCT / 100) * highWater;
  const maxDist = (TRAIL_MAX_PCT / 100) * highWater;
  const atrDist = Number.isFinite(atr5m) && atr5m > 0 ? TRAIL_ATR_MULT * atr5m : 0;
  let trailDist = atrDist;
  let basis: TrailResolution['basis'] = 'atr';
  if (!(atrDist > 0) || atrDist < minDist) { trailDist = minDist; basis = 'floor'; }
  else if (atrDist > maxDist) { trailDist = maxDist; basis = 'cap'; }
  const stopPrice = side === 1 ? highWater - trailDist : highWater + trailDist;
  return { stopPrice, trailDist, trailPct: (trailDist / highWater) * 100, basis };
}

/** Risk-first sizing: take only as many shares as keep the loss-at-stop = RISK_PER_TRADE. */
export function sizeQuantity(stopDist: number): number {
  if (!(stopDist > 0)) return 0;
  return Math.floor(RISK_PER_TRADE / stopDist);
}
