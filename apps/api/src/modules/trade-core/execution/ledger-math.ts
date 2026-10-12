import { Prisma } from '@prisma/client';
import type { LedgerType, OrderSide } from './execution.types';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

export const ZERO: Dec = new D(0);

/** One ledger amount: rupees to the paisa, half-up. Every ledger row is rounded exactly once, here. */
export function money(v: string | number | Dec): Dec {
  return new D(v).toDecimalPlaces(2, D.ROUND_HALF_UP);
}

export interface LedgerAmount {
  type: LedgerType;
  amount: Dec;
}

export interface Balances {
  deposited: Dec;
  realisedPnl: Dec;
  /** Positive: the charges paid. */
  charges: Dec;
  /** Positive: the interest paid. */
  mtfInterest: Dec;
  /** Money the user owns: deposits + realised P&L − charges − interest. */
  cash: Dec;
  /** −Σ margin rows. */
  blockedMargin: Dec;
  /** cash − blockedMargin, which is exactly Σ every row. */
  freeCash: Dec;
}

/**
 * Signs (the migration's CHECK enforces them): DEPOSIT +, MARGIN_BLOCK −, MARGIN_RELEASE +,
 * CHARGES −, MTF_INTEREST ≤ 0, REALISED_PNL either.
 */
export function balances(rows: readonly LedgerAmount[]): Balances {
  const sum = (types: readonly LedgerType[]) => rows.filter((r) => types.includes(r.type)).reduce((a, r) => a.plus(r.amount), ZERO);
  const deposited = sum(['DEPOSIT']);
  const realisedPnl = sum(['REALISED_PNL']);
  const charges = ZERO.minus(sum(['CHARGES']));
  const mtfInterest = ZERO.minus(sum(['MTF_INTEREST']));
  const cash = deposited.plus(realisedPnl).minus(charges).minus(mtfInterest);
  const blockedMargin = ZERO.minus(sum(['MARGIN_BLOCK', 'MARGIN_RELEASE']));
  return { deposited, realisedPnl, charges, mtfInterest, cash, blockedMargin, freeCash: cash.minus(blockedMargin) };
}

export interface PositionFill {
  side: OrderSide;
  qty: number;
  price: Dec;
  at: Date;
}

export interface PositionState {
  /** Signed: positive long, negative short. */
  netQty: number;
  avgPrice: Dec | null;
  /** Σ of the realised P&L booked so far, each part rounded as its ledger row was. */
  realised: Dec;
  /** When the current holding opened (its first fill since flat). */
  openedAt: Date | null;
}

export const FLAT: PositionState = { netQty: 0, avgPrice: null, realised: ZERO, openedAt: null };

/** Gross realised P&L of reducing `qty` at `price` (spec §4.4: (exit − average entry) × qty × direction). */
export function realisedOnReduce(avg: Dec, price: Dec, qty: number, direction: 1 | -1): Dec {
  return money(price.minus(avg).mul(qty).mul(direction));
}

/** Average-cost position arithmetic. A reducing fill realises; a fill that would flip the position throws. */
export function applyPositionFill(s: PositionState, f: PositionFill): { state: PositionState; realised: Dec | null } {
  const signed = f.side === 'BUY' ? f.qty : -f.qty;
  if (s.netQty === 0 || Math.sign(signed) === Math.sign(s.netQty)) {
    const held = Math.abs(s.netQty);
    const avgPrice = s.avgPrice === null || held === 0 ? f.price : s.avgPrice.mul(held).plus(f.price.mul(f.qty)).div(held + f.qty);
    return { state: { netQty: s.netQty + signed, avgPrice, realised: s.realised, openedAt: s.netQty === 0 ? f.at : s.openedAt }, realised: null };
  }
  if (f.qty > Math.abs(s.netQty)) throw new Error(`a ${f.side} of ${f.qty} would flip a position of ${s.netQty}`);
  const realised = realisedOnReduce(s.avgPrice as Dec, f.price, f.qty, s.netQty > 0 ? 1 : -1);
  const netQty = s.netQty + signed;
  return {
    state: { netQty, avgPrice: netQty === 0 ? null : s.avgPrice, realised: s.realised.plus(realised), openedAt: netQty === 0 ? null : s.openedAt },
    realised,
  };
}

export function positionFromFills(fills: readonly PositionFill[]): PositionState {
  return fills.reduce((s, f) => applyPositionFill(s, f).state, FLAT);
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The IST calendar date, YYYY-MM-DD. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextDate(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The IST calendar days to charge (spec §4.4, plan ruling 10): from the day after the
 * last posting, or from the opening day when nothing of this holding was posted, through
 * upTo inclusive. A weekend or a missed night is caught up; a posted day never repeats.
 */
export function mtfInterestDays(openedOn: string, lastPosted: string | null, upTo: string): string[] {
  let day = lastPosted !== null && lastPosted >= openedOn ? nextDate(lastPosted) : openedOn;
  const out: string[] = [];
  while (day <= upTo) {
    out.push(day);
    day = nextDate(day);
  }
  return out;
}

/** One day's interest on the funded amount: funded × annual rate ÷ 100 ÷ 365, to the paisa. */
export function dailyMtfInterest(funded: Dec, annualRatePct: Dec): Dec {
  return money(funded.mul(annualRatePct).div(100).div(365));
}
