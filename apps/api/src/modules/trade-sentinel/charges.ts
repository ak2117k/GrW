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
 * Rates are Angel One / exchange published values as of 2026-08. They are
 * approximations for decision-making, not a contract-note reconciliation.
 */

export type Segment = 'EQ_DELIVERY' | 'EQ_INTRADAY' | 'FUT' | 'OPT';
export type Side = 'LONG' | 'SHORT';

/** Cushion above breakeven before the floor arms, so noise can't un-arm it. */
export const GREEN_FLOOR_MARGIN_RUPEES = 150;

const BROKERAGE_FLAT = 20; // Rs per executed order, capped
const BROKERAGE_PCT = 0.0003; // 0.03% for intraday/futures, whichever is lower
const GST = 0.18;

interface Rates {
  /** Securities Transaction Tax, charged on the sell side only unless noted. */
  sttSell: number;
  sttBuy: number;
  exchangeTxn: number;
  stampBuy: number;
  brokerageFree: boolean;
}

const RATES: Record<Segment, Rates> = {
  EQ_DELIVERY: { sttSell: 0.001, sttBuy: 0.001, exchangeTxn: 0.0000297, stampBuy: 0.00015, brokerageFree: true },
  EQ_INTRADAY: { sttSell: 0.00025, sttBuy: 0, exchangeTxn: 0.0000297, stampBuy: 0.00003, brokerageFree: false },
  FUT: { sttSell: 0.0002, sttBuy: 0, exchangeTxn: 0.0000173, stampBuy: 0.00002, brokerageFree: false },
  OPT: { sttSell: 0.001, sttBuy: 0, exchangeTxn: 0.0003503, stampBuy: 0.00003, brokerageFree: false },
};

export interface ChargeInput {
  segment: Segment;
  entryPrice: number;
  exitPrice: number;
  qty: number;
}

/** Total round-trip charges in rupees. Always >= 0. */
export function estimateCharges({ segment, entryPrice, exitPrice, qty }: ChargeInput): number {
  const r = RATES[segment];
  const buyTurnover = Math.abs(entryPrice * qty);
  const sellTurnover = Math.abs(exitPrice * qty);
  const turnover = buyTurnover + sellTurnover;

  // Options brokerage is flat per order; everything else takes the lower of
  // flat-vs-percentage, which is how discount brokers actually bill.
  const perOrder = segment === 'OPT'
    ? BROKERAGE_FLAT
    : Math.min(BROKERAGE_FLAT, Math.max(buyTurnover, sellTurnover) * BROKERAGE_PCT);
  const brokerage = r.brokerageFree ? 0 : perOrder * 2;

  const stt = sellTurnover * r.sttSell + buyTurnover * r.sttBuy;
  const exchange = turnover * r.exchangeTxn;
  const stamp = buyTurnover * r.stampBuy;
  const sebi = turnover * 0.000001;
  const gst = (brokerage + exchange + sebi) * GST;

  return brokerage + stt + exchange + stamp + sebi + gst;
}

export interface GreenFloorInput {
  segment: Segment;
  entryPrice: number;
  ltp: number;
  qty: number;
  side: Side;
}

export interface GreenFloor {
  /** True once net P&L has cleared charges + margin at least once this evaluation. */
  armed: boolean;
  /** The price at which net P&L equals the margin. Null if qty is zero. */
  floorPrice: number | null;
  netPnl: number;
  charges: number;
  marginRupees: number;
}

/**
 * Net P&L and the price that locks it in. `armed` is computed from the CURRENT
 * ltp only; the caller is responsible for latching it (once armed, always armed
 * for that position) — the ratchet is state, and this function stays pure.
 */
export function computeGreenFloor({ segment, entryPrice, ltp, qty, side }: GreenFloorInput): GreenFloor {
  const dir = side === 'LONG' ? 1 : -1;
  const charges = estimateCharges({ segment, entryPrice, exitPrice: ltp, qty });
  const gross = (ltp - entryPrice) * qty * dir;
  const netPnl = gross - charges;

  if (qty === 0) {
    return { armed: false, floorPrice: null, netPnl, charges, marginRupees: GREEN_FLOOR_MARGIN_RUPEES };
  }

  // Price at which gross P&L covers charges + margin.
  const needed = charges + GREEN_FLOOR_MARGIN_RUPEES;
  const floorPrice = entryPrice + (needed / qty) * dir;

  return {
    armed: netPnl >= GREEN_FLOOR_MARGIN_RUPEES,
    floorPrice,
    netPnl,
    charges,
    marginRupees: GREEN_FLOOR_MARGIN_RUPEES,
  };
}
