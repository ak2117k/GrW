import { Prisma } from '@prisma/client';
import type { DepthLevel, PriceDepth } from '../../market-hub/hub.types';
import { VEHICLE_EXCHANGES } from '../risk-wall/session-open';
import { VEHICLES } from '../strategies/blocks/block-types';
import { ORDER_TYPES, type CoreOrderRequest, type OrderSide, type OrderType } from './execution.types';
import type { PaperSettings } from './paper-settings';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

/**
 * Spec §4.3 (parent §6.3): a price older than this is never filled on. A freshness rule
 * fixed by the spec, not a money or risk value.
 */
export const PRICE_MAX_AGE_MS = 15_000;

/** The parts of a hub Price the model reads (market-hub/hub.types.ts Price satisfies it). */
export interface FillPrice {
  ltp: number;
  /** Receipt time, ms epoch. */
  at: number;
  depth?: PriceDepth;
}

export interface FillableOrder {
  side: OrderSide;
  type: OrderType;
  qty: number;
  filledQty: number;
  instrument: { lotSize: number };
  limitPrice: number | null;
  triggerPrice: number | null;
  submittedAt: Date;
  /** SL_MARKET: when the trigger was first reached (P10); null while untriggered. */
  triggeredAt: Date | null;
}

/**
 * `triggered: true` appears only on the decision for the price that FIRST reaches an
 * untriggered SL_MARKET's trigger, with or without a fill; the caller persists triggeredAt
 * (P10). Absent otherwise, including for an already-triggered stop.
 */
export type FillDecision =
  | { kind: 'NONE'; reason: string; triggered?: true }
  | { kind: 'FILL'; qty: number; price: Dec; via: 'DEPTH' | 'SLIPPAGE' | 'LIMIT'; triggered?: true };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Null when `p` may be used for an order submitted at `submittedAtMs`: positive, STRICTLY after submission, ≤ 15 s old. */
export function priceProblem(p: FillPrice, submittedAtMs: number, now: number): string | null {
  if (!finite(p.ltp) || p.ltp <= 0) return 'the price is not positive';
  if (!finite(p.at) || p.at <= submittedAtMs) return 'the price is not after the order was submitted';
  if (now - p.at > PRICE_MAX_AGE_MS) return `the price is ${now - p.at} ms old`;
  return null;
}

/** When an order that has seen no usable price is rejected: noPriceRejectMs after submission, or after a reload. */
export function noPriceDeadline(submittedAtMs: number, trackedFromMs: number, noPriceRejectMs: number): number {
  return Math.max(submittedAtMs, trackedFromMs) + noPriceRejectMs;
}

/** Levels a fill can use: a positive price and a positive whole quantity. */
function usable(levels: readonly DepthLevel[] | undefined): DepthLevel[] {
  return (levels ?? []).filter((l) => finite(l.price) && l.price > 0 && Number.isSafeInteger(l.qty) && l.qty > 0);
}

/** Buys round up, sells round down: the paper fill is never better than the price allows. */
const againstTrader = (side: OrderSide, v: Dec, dp: number): Dec => v.toDecimalPlaces(dp, side === 'BUY' ? D.ROUND_CEIL : D.ROUND_FLOOR);

function marketFill(order: FillableOrder, p: FillPrice, remaining: number, slippageBps: Dec): FillDecision {
  const lot = order.instrument.lotSize;
  const bids = usable(p.depth?.bids);
  const asks = usable(p.depth?.asks);
  if (bids.length === 0 && asks.length === 0) {
    const shift = slippageBps.div(10_000);
    const factor = order.side === 'BUY' ? new D(1).plus(shift) : new D(1).minus(shift);
    const price = againstTrader(order.side, new D(p.ltp).mul(factor), 2);
    if (price.lte(0)) return { kind: 'NONE', reason: 'slippage leaves no positive price' };
    return { kind: 'FILL', qty: remaining, price, via: 'SLIPPAGE' };
  }
  const book = order.side === 'BUY' ? [...asks].sort((a, b) => a.price - b.price) : [...bids].sort((a, b) => b.price - a.price);
  if (book.length === 0) return { kind: 'NONE', reason: order.side === 'BUY' ? 'the book has no asks' : 'the book has no bids' };
  const available = book.reduce((n, l) => n + l.qty, 0);
  const qty = Math.min(remaining, Math.floor(available / lot) * lot);
  if (qty <= 0) return { kind: 'NONE', reason: `the book holds less than one lot (${available} < ${lot})` };
  let left = qty;
  let value = new D(0);
  for (const level of book) {
    if (left === 0) break;
    const take = Math.min(left, level.qty);
    value = value.plus(new D(level.price).mul(take));
    left -= take;
  }
  return { kind: 'FILL', qty, price: againstTrader(order.side, value.div(qty), 4), via: 'DEPTH' };
}

/**
 * Spec §4.3. MARKET walks the opposite side of the depth for the remaining qty (whole
 * lots), else LTP ± slippage when the price has no usable depth at all; a book with
 * levels only on the wrong side waits (plan ruling 6). LIMIT fills the whole remainder
 * at the limit on a strict trade-through (E3). SL_MARKET triggers at the trigger (BUY ≥,
 * SELL ≤) and then fills as MARKET on this price (a gap fills at the gap price). Once
 * triggered (triggeredAt set, or any fill) it never un-triggers (P10): the trigger check is
 * skipped and every later fresh price fills as MARKET.
 */
export function decideFill(order: FillableOrder, p: FillPrice, now: number, slippageBps: Dec): FillDecision {
  const problem = priceProblem(p, order.submittedAt.getTime(), now);
  if (problem) return { kind: 'NONE', reason: problem };
  const remaining = order.qty - order.filledQty;
  if (remaining <= 0) return { kind: 'NONE', reason: 'nothing left to fill' };
  if (order.type === 'LIMIT') {
    const limit = order.limitPrice as number;
    const through = order.side === 'BUY' ? p.ltp < limit : p.ltp > limit;
    if (!through) return { kind: 'NONE', reason: `the price ${p.ltp} has not traded through the limit ${limit}` };
    return { kind: 'FILL', qty: remaining, price: new D(limit), via: 'LIMIT' };
  }
  if (order.type === 'SL_MARKET' && order.filledQty === 0 && order.triggeredAt === null) {
    const trigger = order.triggerPrice as number;
    const hit = order.side === 'BUY' ? p.ltp >= trigger : p.ltp <= trigger;
    if (!hit) return { kind: 'NONE', reason: `the price ${p.ltp} has not reached the trigger ${trigger}` };
    return { ...marketFill(order, p, remaining, slippageBps), triggered: true };
  }
  return marketFill(order, p, remaining, slippageBps);
}

/*
 * Shared order rules (ruling P7): the ONE copy of the lot-multiple, max-lots and 2-decimal
 * price rules. validateOrder / requestProblems use them here; the order-modify path
 * imports them rather than restating them.
 */

/** True when `qty` is a safe whole number of units that is an exact multiple of `lotSize`. */
export function isWholeLots(qty: number, lotSize: number): boolean {
  return Number.isSafeInteger(qty) && qty % lotSize === 0;
}

/**
 * E4: an option order's lots must stay within its underlying's maxLotsPerOrder row. The
 * underlying is matched trimmed and upper-cased; a missing underlying or row fails closed.
 */
export function maxLotsProblem(
  qty: number,
  lotSize: number,
  underlying: string | null,
  maxLotsPerOrder: PaperSettings['maxLotsPerOrder'],
): string | null {
  const key = (underlying ?? '').trim().toUpperCase();
  if (!key) return 'an option order needs its underlying';
  const maxLots = maxLotsPerOrder[key];
  if (maxLots === undefined) return `no maxLotsPerOrder setting for ${key}`;
  const lots = qty / lotSize;
  if (lots > maxLots) return `${lots} lots exceed the ${maxLots}-lot limit per order for ${key}`;
  return null;
}

/** Null when `v` is a usable order price: finite, above 0, at most 2 decimals (Decimal(14,2) columns). */
export function priceShapeProblem(v: unknown, name: string): string | null {
  if (!finite(v) || v <= 0 || new D(v).decimalPlaces() > 2) return `${name} must be a price above 0 with at most 2 decimals`;
  return null;
}

export interface OrderCheckContext {
  settings: PaperSettings;
  /** The user's net position on the order's (vehicle, token): positive long, negative short. */
  position: { netQty: number };
  /** Units of open EXIT orders on the same key not yet filled. */
  pendingExitQty: number;
}

/** Business rules that REJECT a well-formed order (spec §4.3); null when it may rest. */
export function validateOrder(req: CoreOrderRequest, ctx: OrderCheckContext): string | null {
  const { lotSize } = req.instrument;
  const exchange = req.instrument.exchange.toUpperCase();
  const venues = VEHICLE_EXCHANGES[req.vehicle];
  if (!venues.includes(exchange)) return `${req.vehicle} trades on ${venues.join('/')}, not ${req.instrument.exchange}`;
  if (!isWholeLots(req.qty, lotSize)) return `qty ${req.qty} is not a multiple of the lot size ${lotSize}`;
  if (req.vehicle === 'OPTIONS_BUY') {
    const problem = maxLotsProblem(req.qty, lotSize, req.instrument.underlying, ctx.settings.maxLotsPerOrder);
    if (problem) return problem;
  }
  const net = ctx.position.netQty;
  if (req.purpose === 'ENTRY') {
    if (req.vehicle !== 'CASH_INTRADAY' && req.side !== 'BUY') return `${req.vehicle} opens only with BUY`;
    if ((req.side === 'BUY' && net < 0) || (req.side === 'SELL' && net > 0)) return 'an ENTRY may not reduce the open position; place an EXIT';
    return null;
  }
  if (net === 0) return 'no open position to exit';
  const closing: OrderSide = net > 0 ? 'SELL' : 'BUY';
  if (req.side !== closing) return `an exit of a ${net > 0 ? 'long' : 'short'} position must ${closing}`;
  const free = Math.abs(net) - ctx.pendingExitQty;
  if (req.qty > free) return `exit qty ${req.qty} exceeds the ${free} units not already being exited`;
  return null;
}

/** Shape problems: a request with any is a programming error (400), never persisted (plan ruling 8). */
export function requestProblems(req: CoreOrderRequest): string[] {
  const out: string[] = [];
  const text = (v: unknown, name: string) => {
    if (typeof v !== 'string' || v.trim() === '') out.push(`${name} is required`);
  };
  const price = (v: unknown, name: string) => {
    const problem = priceShapeProblem(v, name);
    if (problem) out.push(problem);
  };
  text(req.userId, 'userId');
  text(req.idempotencyKey, 'idempotencyKey');
  if (typeof req.idempotencyKey === 'string' && req.idempotencyKey.length > 200) out.push('idempotencyKey is longer than 200 characters');
  if (!(VEHICLES as readonly unknown[]).includes(req.vehicle)) out.push(`unknown vehicle ${String(req.vehicle)}`);
  text(req.instrument?.exchange, 'instrument.exchange');
  text(req.instrument?.token, 'instrument.token');
  text(req.instrument?.symbol, 'instrument.symbol');
  if (!Number.isSafeInteger(req.instrument?.lotSize) || req.instrument.lotSize < 1) out.push('instrument.lotSize must be a whole number of 1 or more');
  if (req.side !== 'BUY' && req.side !== 'SELL') out.push('side must be BUY or SELL');
  if (!(ORDER_TYPES as readonly unknown[]).includes(req.type)) out.push(`unknown order type ${String(req.type)}`);
  if (req.purpose !== 'ENTRY' && req.purpose !== 'EXIT') out.push('purpose must be ENTRY or EXIT');
  if (!Number.isSafeInteger(req.qty) || req.qty < 1) out.push('qty must be a whole number of 1 or more');
  price(req.refPrice, 'refPrice');
  if (req.type === 'LIMIT') price(req.limitPrice, 'limitPrice');
  else if (req.limitPrice !== null) out.push('limitPrice is only for LIMIT orders');
  if (req.type === 'SL_MARKET') price(req.triggerPrice, 'triggerPrice');
  else if (req.triggerPrice !== null) out.push('triggerPrice is only for SL_MARKET orders');
  return out;
}
