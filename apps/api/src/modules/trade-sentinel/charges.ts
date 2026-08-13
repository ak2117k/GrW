/**
 * Charge model for Indian equity/F&O round trips, and the "green floor" derived
 * from it.
 *
 * The floor is the price at which the trade's NET P&L (after every statutory and
 * broker charge) equals the charges plus a safety margin. Once unrealised net
 * P&L clears that bar the floor ARMS: from then on the trade must not be allowed
 * back into the red. This is deliberately arithmetic, not judgment — the agent
 * decides when to take MORE than the floor, never whether the floor applies.
 *
 * Rates are Angel One / NSE published values as of 2026-08. Exchange transaction
 * rates are NSE's; BSE differs and is not modelled. These are approximations for
 * decision-making, NOT a contract-note reconciliation — no figure here has been
 * checked against a real contract note.
 *
 * Charges are side-aware. STT falls on the SELL leg (plus the buy leg for
 * delivery) and stamp duty on the BUY leg, and for a SHORT the sell leg is the
 * ENTRY, not the exit. Deriving the legs from entry/exit instead of from `side`
 * understates a short's charges in the unsafe direction, so `side` is required.
 */

export type Segment = 'EQ_DELIVERY' | 'EQ_INTRADAY' | 'FUT' | 'OPT';
export type Side = 'LONG' | 'SHORT';

/** Cushion above breakeven before the floor arms, so noise can't un-arm it. */
export const GREEN_FLOOR_MARGIN_RUPEES = 150;

const BROKERAGE_FLAT = 20; // Rs per executed order, capped
const BROKERAGE_PCT = 0.0025; // Angel One: Rs 20 or 0.25% per order, whichever is lower
const GST = 0.18;

/**
 * CDSL/DP charge: a flat rupee amount per scrip per SELL order on delivery
 * holdings. It is not turnover-linked and does not scale with quantity, so a
 * single-scrip round trip incurs it exactly once. GST applies on top.
 */
const DP_CHARGE_PER_SELL_RUPEES = 15.93;

/** Fixed-point solve for the floor price: charges depend on the exit price. */
const FLOOR_MAX_ITERATIONS = 12;
const FLOOR_TOLERANCE_RUPEES = 1e-9;
/** Indian equities and derivatives quote in paise. */
const TICK_SIZE = 0.01;

interface Rates {
  /** Securities Transaction Tax on the sell leg. */
  sttSell: number;
  /** STT on the buy leg — delivery only; zero for intraday and derivatives. */
  sttBuy: number;
  exchangeTxn: number;
  /** Stamp duty, buy leg only. */
  stampBuy: number;
}

const RATES: Record<Segment, Rates> = {
  EQ_DELIVERY: { sttSell: 0.001, sttBuy: 0.001, exchangeTxn: 0.0000297, stampBuy: 0.00015 },
  EQ_INTRADAY: { sttSell: 0.00025, sttBuy: 0, exchangeTxn: 0.0000297, stampBuy: 0.00003 },
  FUT: { sttSell: 0.0002, sttBuy: 0, exchangeTxn: 0.0000173, stampBuy: 0.00002 },
  OPT: { sttSell: 0.001, sttBuy: 0, exchangeTxn: 0.0003503, stampBuy: 0.00003 },
};

export interface ChargeInput {
  segment: Segment;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  /** Direction of the position. Decides which leg is the sell and which the buy. */
  side: Side;
}

/** Brokerage on one executed order: flat for options, else the lower of flat vs %. */
function legBrokerage(segment: Segment, legTurnover: number): number {
  if (segment === 'OPT') return BROKERAGE_FLAT;
  return Math.min(BROKERAGE_FLAT, legTurnover * BROKERAGE_PCT);
}

/** Total round-trip charges in rupees. Always >= 0. */
export function estimateCharges({ segment, entryPrice, exitPrice, qty, side }: ChargeInput): number {
  const r = RATES[segment];
  const entryTurnover = Math.abs(entryPrice * qty);
  const exitTurnover = Math.abs(exitPrice * qty);

  // A LONG buys at entry and sells at exit; a SHORT does the reverse.
  const buyTurnover = side === 'LONG' ? entryTurnover : exitTurnover;
  const sellTurnover = side === 'LONG' ? exitTurnover : entryTurnover;
  const turnover = buyTurnover + sellTurnover;

  // Brokerage is per executed order, so price each leg on its own turnover.
  const brokerage = legBrokerage(segment, buyTurnover) + legBrokerage(segment, sellTurnover);

  const stt = sellTurnover * r.sttSell + buyTurnover * r.sttBuy;
  const exchange = turnover * r.exchangeTxn;
  const stamp = buyTurnover * r.stampBuy;
  const sebi = turnover * 0.000001;
  const dp = segment === 'EQ_DELIVERY' ? DP_CHARGE_PER_SELL_RUPEES : 0;
  const gst = (brokerage + exchange + sebi + dp) * GST;

  return brokerage + stt + exchange + stamp + sebi + dp + gst;
}

export interface GreenFloorInput {
  segment: Segment;
  entryPrice: number;
  ltp: number;
  qty: number;
  side: Side;
}

export interface GreenFloor {
  /** True if net P&L AT THE CURRENT ltp clears charges + the margin. Not latched. */
  armed: boolean;
  /**
   * The exit price at which net P&L is at least the margin, rounded to the next
   * tick in the conservative direction. Null if qty is zero.
   */
  floorPrice: number | null;
  netPnl: number;
  charges: number;
  marginRupees: number;
}

/** Round to the next tick in the direction that can only help the trade. */
function roundToTickConservative(price: number, dir: number): number {
  const ticks = price / TICK_SIZE;
  return (dir === 1 ? Math.ceil(ticks) : Math.floor(ticks)) * TICK_SIZE;
}

/**
 * Net P&L and the price that locks it in. `armed` is computed from the CURRENT
 * ltp only; the caller is responsible for latching it (once armed, always armed
 * for that position) — the ratchet is state, and this function stays pure.
 *
 * `floorPrice` is solved as a fixed point: charges depend on the exit price, so
 * the price that nets the margin depends on the charges at that same price. A
 * single pass off the current ltp is optimistic for shorts and for longs below
 * the floor — badly so for option shorts, where it can return a price that locks
 * in a LOSS. The iteration below converges (charges move ~0.1-0.3% per rupee of
 * price, a strong contraction) and the result is then nudged one tick in the
 * conservative direction so the guarantee holds strictly rather than to rounding.
 */
export function computeGreenFloor({ segment, entryPrice, ltp, qty, side }: GreenFloorInput): GreenFloor {
  const dir = side === 'LONG' ? 1 : -1;
  const charges = estimateCharges({ segment, entryPrice, exitPrice: ltp, qty, side });
  const gross = (ltp - entryPrice) * qty * dir;
  const netPnl = gross - charges;

  if (qty === 0) {
    return { armed: false, floorPrice: null, netPnl, charges, marginRupees: GREEN_FLOOR_MARGIN_RUPEES };
  }

  // Price at which gross P&L covers the charges incurred AT THAT PRICE, plus the margin.
  let floorPrice = entryPrice + ((charges + GREEN_FLOOR_MARGIN_RUPEES) / qty) * dir;
  for (let i = 0; i < FLOOR_MAX_ITERATIONS; i += 1) {
    const chargesAtFloor = estimateCharges({ segment, entryPrice, exitPrice: floorPrice, qty, side });
    const next = entryPrice + ((chargesAtFloor + GREEN_FLOOR_MARGIN_RUPEES) / qty) * dir;
    const converged = Math.abs(next - floorPrice) < FLOOR_TOLERANCE_RUPEES;
    floorPrice = next;
    if (converged) break;
  }

  return {
    armed: netPnl >= GREEN_FLOOR_MARGIN_RUPEES,
    floorPrice: roundToTickConservative(floorPrice, dir),
    netPnl,
    charges,
    marginRupees: GREEN_FLOOR_MARGIN_RUPEES,
  };
}
