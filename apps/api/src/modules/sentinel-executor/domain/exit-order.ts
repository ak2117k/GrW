// apps/api/src/modules/sentinel-executor/domain/exit-order.ts
import type { OrderRequest } from '../../../common/interfaces/broker-adapter.interface';
import type { AutoExitMode, QtyUnit } from './auto-exit.types';
import type { ExitTrigger } from './manual-exit';
import { MAX_PROTECTIVE_CANCELS } from './claim-timing';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const PRODUCTS = new Set(['INTRADAY', 'CARRYFORWARD', 'DELIVERY']);
const TERMINAL = new Set(['complete', 'rejected', 'cancelled']);

/** Prefix of every ordertag the executor sends (R4). auto-execution tags are 'ae' + idempotency-key hex, never 'ax'. */
export const AI_EXIT_TAG_PREFIX = 'ax';
/** Prefix of the owner's manual "Exit now" ordertags. Every exit prefix counts as a prior exit. */
export const MANUAL_EXIT_TAG_PREFIX = 'am';
/** Prefix of a price-trigger fire's ordertags (price-triggers plan R13). */
export const PRICE_TRIGGER_TAG_PREFIX = 'at';
const EXIT_TAG_PREFIXES = [AI_EXIT_TAG_PREFIX, MANUAL_EXIT_TAG_PREFIX, PRICE_TRIGGER_TAG_PREFIX];
const TAG_PREFIX: Record<ExitTrigger, string> = {
  AI: AI_EXIT_TAG_PREFIX,
  MANUAL: MANUAL_EXIT_TAG_PREFIX,
  PRICE_TRIGGER: PRICE_TRIGGER_TAG_PREFIX,
};

type Row = Record<string, unknown>;

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const matches = (r: Row, exchange: string, token: string) =>
  String(r?.symboltoken ?? '') === token && up(r?.exchange) === up(exchange);
/** A usable lot size is a whole number ≥ 1; anything else is "unknown". */
const lotOf = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = toNum(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/**
 * How to express the order quantity (plan ruling R16). `qtyUnit` is the configured
 * unit for the position's exchange (`config.qtyUnits[exchange]`); missing = unverified.
 */
export interface QtyPolicy {
  mode: AutoExitMode;
  qtyUnit: QtyUnit | null | undefined;
}

export type ExitPlan =
  | {
      ok: true;
      order: OrderRequest;
      /** Signed broker net quantity, in the broker's positions unit (taken as units). */
      netQty: number;
      ltp: number;
      /** The unit `order.quantity` is expressed in; null when unverified (dry-run only). */
      qtyUnit: QtyUnit | null;
      /** false only in dry-run with no configured unit: the row must be flagged, never sent. */
      unitVerified: boolean;
    }
  | { ok: false; reason: string };

/**
 * The closing order for ONE contract, from a fresh broker positions array
 * (spec §5.4–5.5, plan rulings R3 and R16). Whole position only: |netqty|, converted
 * to the exchange's configured order unit. Identity (symbol, token, exchange, product)
 * comes from the broker row, never the tracker.
 *
 * R16: `target.lotSize` is the instrument's lot size (instrument master); the broker
 * row's own `lotsize` is used when the caller has none, and a disagreement refuses.
 * An exchange with no configured unit is refused in live mode; dry-run records
 * |netqty| with `unitVerified: false`.
 */
export function planExitOrder(
  rows: unknown[],
  target: { exchange: string; token: string; trackerQty: number; lotSize?: number | null },
  policy: QtyPolicy,
): ExitPlan {
  const live = (rows as Row[]).filter((r) => matches(r, target.exchange, target.token) && toNum(r?.netqty) !== 0);
  if (live.length === 0) return { ok: false, reason: 'ALREADY_FLAT' };
  if (live.length > 1) return { ok: false, reason: 'AMBIGUOUS_POSITION_ROWS' };
  const r = live[0];
  const netQty = toNum(r.netqty);
  if (!Number.isInteger(netQty)) return { ok: false, reason: 'BAD_QTY' };
  if (target.trackerQty !== 0 && Math.sign(target.trackerQty) !== Math.sign(netQty)) {
    return { ok: false, reason: 'SIDE_MISMATCH' };
  }
  const product = up(r.producttype);
  if (!PRODUCTS.has(product)) return { ok: false, reason: `UNKNOWN_PRODUCT:${product || 'NONE'}` };
  const symbol = String(r.tradingsymbol ?? '').trim();
  if (!symbol) return { ok: false, reason: 'NO_SYMBOL' };
  const exchange = up(r.exchange);

  // R16 — quantity unit.
  const callerLot = lotOf(target.lotSize);
  const rowLot = lotOf(r.lotsize);
  if (callerLot !== null && rowLot !== null && callerLot !== rowLot) {
    return { ok: false, reason: 'LOT_SIZE_MISMATCH' };
  }
  const lot = callerLot ?? rowLot;
  const units = Math.abs(netQty);
  const unit = policy.qtyUnit ?? null;

  let quantity: number;
  if (unit === null) {
    if (policy.mode === 'live') return { ok: false, reason: `QTY_UNIT_UNCONFIGURED:${exchange}` };
    quantity = units; // dry-run only: recorded, flagged unit-unverified, never sent
  } else {
    if (lot !== null && units % lot !== 0) return { ok: false, reason: 'QTY_NOT_LOT_MULTIPLE' };
    if (unit === 'lots') {
      if (lot === null) return { ok: false, reason: 'NO_LOT_SIZE' };
      // Every master parser in the repo coerces a missing lotsize to 1, so a caller
      // lot of 1 may mean "unknown"; dividing by it would send |netqty| LOTS.
      if (lot === 1 && rowLot !== 1) return { ok: false, reason: 'LOT_SIZE_UNCONFIRMED' };
      quantity = units / lot;
    } else {
      quantity = units;
    }
  }

  return {
    ok: true,
    netQty,
    ltp: toNum(r.ltp),
    qtyUnit: unit,
    unitVerified: unit !== null,
    order: {
      symbol,
      token: String(r.symboltoken),
      exchange,
      side: netQty > 0 ? 'SELL' : 'BUY',
      orderType: 'MARKET',
      quantity,
      positionType: product as OrderRequest['positionType'],
    },
  };
}

/** Contract tick in RUPEES (plan ruling R5: the master stores paise). */
export function tickRupees(raw: number | null | undefined, exchange: string): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  if (n >= 1) return n / 100;
  if (n > 0) return n;
  return up(exchange) === 'MCX' ? 1 : 0.05;
}

/** Aggressive LIMIT for the single fallback: SELL floors, BUY ceils, to the tick. */
export function limitFallbackPrice(
  side: 'BUY' | 'SELL',
  ltp: number,
  pct: number,
  tick: number,
): number | null {
  if (!(ltp > 0) || !(tick > 0)) return null;
  const raw = side === 'SELL' ? ltp * (1 - pct / 100) : ltp * (1 + pct / 100);
  const ticks = raw / tick;
  // 1e-9 guards against 49.2/0.05 = 983.9999999 flooring a whole tick away.
  const n = side === 'SELL' ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9);
  const price = Number((n * tick).toFixed(4));
  return price > 0 ? price : null;
}

/**
 * Angel `ordertag` (plan ruling R4): 'ax' (AI), 'am' (owner's manual exit) or
 * 'at' (price-trigger fire) + leg + last 17 alphanumerics of the (possibly
 * synthetic) verdict id. ≤ 20 chars.
 */
export function aiExitOrderTag(verdictId: string, leg: 'M' | 'L', trigger: ExitTrigger = 'AI'): string {
  const clean = String(verdictId).replace(/[^A-Za-z0-9]/g, '');
  return `${TAG_PREFIX[trigger]}${leg}${clean.slice(-17)}`;
}

/** Does this broker text say MARKET orders are refused for the instrument? (ruling R6) */
export function isMarketRefusal(text: string | null | undefined): boolean {
  const t = String(text ?? '').toLowerCase();
  if (!t.includes('market')) return false;
  return /(not\s+allowed|not\s+permitted|blocked|disallowed|not\s+available|only\s+limit|place\s+a?\s*limit)/.test(t);
}

export interface OrderBookEntry {
  status: string;
  text: string;
}

export function findOrder(rows: unknown[], orderId: string): OrderBookEntry | null {
  const r = (rows as Row[]).find((o) => String(o?.orderid ?? '') === orderId);
  if (!r) return null;
  return { status: String(r.status ?? r.orderstatus ?? '').toLowerCase(), text: String(r.text ?? '') };
}

/** rejected/cancelled: the order never moved (or no longer can move) the position. */
export function isDeadOrderStatus(status: string): boolean {
  const s = String(status).toLowerCase();
  return s === 'rejected' || s === 'cancelled';
}

const statusOf = (r: Row) => String(r?.status ?? r?.orderstatus ?? '').toLowerCase();

/**
 * Our own order in the book, found by its `ordertag` (review fix 1). A live
 * (not rejected/cancelled) row wins over a dead one if the tag appears twice.
 */
export function findOrderByTag(rows: unknown[], tag: string): (OrderBookEntry & { orderId: string }) | null {
  const mine = (rows as Row[]).filter((o) => String(o?.ordertag ?? '') === tag);
  if (mine.length === 0) return null;
  const r = mine.find((o) => !isDeadOrderStatus(statusOf(o))) ?? mine[0];
  return { orderId: String(r.orderid ?? ''), status: statusOf(r), text: String(r.text ?? '') };
}


/**
 * Review fix 2 (PRIOR_AI_EXIT_TODAY): does today's book hold an exit order of
 * ours — AI ('ax'), the owner's manual button ('am') or a price trigger ('at') — on this contract that
 * may have moved the position (anything but rejected/cancelled)?
 * Angel's order book only carries the current trading day.
 */
export function hasPriorAiExit(rows: unknown[], exchange: string, token: string): boolean {
  return (rows as Row[]).some((o) => {
    const tag = String(o?.ordertag ?? '');
    return matches(o, exchange, token)
      && EXIT_TAG_PREFIXES.some((p) => tag.startsWith(p))
      && !isDeadOrderStatus(statusOf(o));
  });
}

export function isTerminalOrderStatus(status: string): boolean {
  return TERMINAL.has(String(status).toLowerCase());
}

/** Any order on this contract that is not complete/rejected/cancelled (unknown counts as open). */
export function hasOpenOrderFor(rows: unknown[], exchange: string, token: string): boolean {
  return (rows as Row[]).some(
    (o) => matches(o, exchange, token) && !isTerminalOrderStatus(String(o?.status ?? o?.orderstatus ?? '')),
  );
}

/** Order types a protective exit-side order may have (Angel order-book `ordertype`). */
const PROTECTIVE_ORDER_TYPES = new Set(['STOPLOSS_MARKET', 'STOPLOSS_LIMIT', 'SL-M', 'SL', 'LIMIT']);
/** Varieties we are willing to cancel: a plain order or a plain stop-loss. Never ROBO (bracket) or AMO. */
const CANCELLABLE_VARIETIES = new Set(['NORMAL', 'STOPLOSS']);

export interface ProtectiveOrder {
  orderId: string;
  variety: string;
  orderType: string;
  side: string;
  /** In the order book's own unit — the same unit the exit order is sent in (R16). */
  quantity: number;
  status: string;
}

export type ProtectiveScan =
  | { kind: 'none' }
  | { kind: 'protective'; orders: ProtectiveOrder[] }
  | { kind: 'blocking' };

/**
 * Cancel protective then exit (2026-10-13). The non-terminal orders on the
 * contract, classified against the exit we are about to send. `protective` only
 * when EVERY one of them is the owner's protection of THIS position: exit side
 * (SELL for a long, BUY for a short), STOPLOSS_MARKET / STOPLOSS_LIMIT or an
 * exit-side LIMIT, quantity ≤ the exit quantity (|netqty| in the order unit),
 * the same product, a NORMAL/STOPLOSS variety and an order id to cancel by.
 * Anything else (an entry-side order, an add, another product, a bracket leg, a
 * bigger order, an unreadable row) makes the whole scan `blocking`: cancel nothing.
 */
export function protectiveOrdersFor(
  rows: unknown[],
  exit: { exchange: string; token: string; side: 'BUY' | 'SELL'; quantity: number; positionType: string },
): ProtectiveScan {
  const open = (rows as Row[]).filter((o) => matches(o, exit.exchange, exit.token) && !isTerminalOrderStatus(statusOf(o)));
  if (open.length === 0) return { kind: 'none' };
  if (open.length > MAX_PROTECTIVE_CANCELS) return { kind: 'blocking' };
  const orders: ProtectiveOrder[] = [];
  for (const o of open) {
    const orderId = String(o?.orderid ?? '').trim();
    const variety = up(o?.variety);
    const orderType = up(o?.ordertype);
    const side = up(o?.transactiontype);
    const qty = toNum(o?.quantity);
    const ok = orderId !== ''
      && CANCELLABLE_VARIETIES.has(variety)
      && PROTECTIVE_ORDER_TYPES.has(orderType)
      && side === exit.side
      && up(o?.producttype) === up(exit.positionType)
      && Number.isInteger(qty) && qty > 0 && qty <= exit.quantity;
    if (!ok) return { kind: 'blocking' };
    orders.push({ orderId, variety, orderType, side, quantity: qty, status: statusOf(o) });
  }
  return { kind: 'protective', orders };
}

/**
 * Where each cancelled-for protective order stands in a fresh order book.
 * `open`: still working, or missing from the book (unknown counts as open).
 * `filled`: complete, or dead with filled shares (it moved the position).
 * cancelled/rejected with nothing filled is simply done.
 */
export function protectiveCancelState(rows: unknown[], orderIds: string[]): { open: string[]; filled: string[] } {
  const open: string[] = [];
  const filled: string[] = [];
  for (const id of orderIds) {
    const r = (rows as Row[]).find((o) => String(o?.orderid ?? '') === id);
    const s = r ? statusOf(r) : '';
    if (!r || !isTerminalOrderStatus(s)) open.push(id);
    else if (s === 'complete' || toNum(r.filledshares) > 0) filled.push(id);
  }
  return { open, filled };
}

/** True when no broker row for the contract has a non-zero net quantity. */
export function isFlat(rows: unknown[], exchange: string, token: string): boolean {
  return !(rows as Row[]).some((r) => matches(r, exchange, token) && toNum(r?.netqty) !== 0);
}

/** UTC instant of the IST midnight that starts `now`'s IST day. */
export function istDayStartUtc(now: Date): Date {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET_MS);
}
