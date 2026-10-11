import { Prisma } from '@prisma/client';
import type { Vehicle } from '../strategies/blocks/block-types';
import type { OrderType } from './execution.types';
import type { PaperSettings } from './paper-settings';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

function rawMargin(vehicle: Vehicle, notional: Dec, s: Pick<PaperSettings, 'intradayLeverage' | 'mtfFundedShare'>): Dec {
  if (vehicle === 'CASH_INTRADAY') return notional.div(s.intradayLeverage);
  if (vehicle === 'MTF') return notional.mul(new D(1).minus(s.mtfFundedShare));
  return notional; // OPTIONS_BUY: the full premium
}

/** Margin a notional blocks (spec §4.4), rounded UP to the paisa so a block is never short. */
export function marginFor(vehicle: Vehicle, notional: Dec, s: Pick<PaperSettings, 'intradayLeverage' | 'mtfFundedShare'>): Dec {
  return rawMargin(vehicle, notional, s).toDecimalPlaces(2, D.ROUND_UP);
}

/** The broker-funded part of an MTF notional: interest accrues on it (spec §4.4). */
export function mtfFunded(notional: Dec, s: Pick<PaperSettings, 'mtfFundedShare'>): Dec {
  return notional.mul(s.mtfFundedShare).toDecimalPlaces(2, D.ROUND_HALF_UP);
}

/** ₹ per unit an order's unfilled qty is blocked at: the limit for LIMIT, else refPrice (plan ruling 2). */
export function marginRefPrice(o: { type: OrderType; limitPrice: number | null; refPrice: number }): Dec {
  return new D(o.type === 'LIMIT' && o.limitPrice !== null ? o.limitPrice : o.refPrice);
}

/**
 * What releasing `qty` of `ofQty` frees from `held`: in proportion, rounded down, and
 * everything on the last part, so a sequence of releases never leaves a residue.
 */
export function proportionalRelease(held: Dec, qty: number, ofQty: number): Dec {
  if (ofQty <= 0 || qty <= 0 || held.lte(0)) return new D(0);
  if (qty >= ofQty) return held;
  return held.mul(qty).div(ofQty).toDecimalPlaces(2, D.ROUND_DOWN);
}
