// apps/api/src/modules/sentinel-executor/domain/owner-orders.ts
import { MAX_PROTECTIVE_CANCELS } from './claim-timing';
import {
  AI_EXIT_TAG_PREFIX,
  MANUAL_EXIT_TAG_PREFIX,
  PRICE_TRIGGER_TAG_PREFIX,
  isTerminalOrderStatus,
  type ProtectiveOrder,
} from './exit-order';
import { FLOOR_STOP_TAG_PREFIX, floorStopTag } from './floor-broker-sl';

/**
 * Every ordertag prefix GrW sends: exits (ax/am/at), the floor stop (afS), auto-execution entries (ae) and
 * signal-trader entries (sg — literal here: importing signal-trader's domain would pull its config in).
 * An order carrying none of them is the owner's (placed at Angel by hand, or by another tool).
 */
export const OUR_ORDER_TAG_PREFIXES: readonly string[] = [
  AI_EXIT_TAG_PREFIX, MANUAL_EXIT_TAG_PREFIX, PRICE_TRIGGER_TAG_PREFIX, FLOOR_STOP_TAG_PREFIX, 'ae', 'sg',
];

type Row = Record<string, unknown>;
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const statusOf = (r: Row) => String(r?.status ?? r?.orderstatus ?? '').toLowerCase();
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
};
const isOurs = (tag: string) => OUR_ORDER_TAG_PREFIXES.some((p) => tag.startsWith(p));

/** An order the executor may cancel before an exit, with what the record needs. `owner` false = our own floor stop. */
export interface CancellableOrder extends ProtectiveOrder {
  price: number | null;
  triggerPrice: number | null;
  owner: boolean;
}

export type OwnerOrderScan =
  /** Nothing open on the contract. */
  | { kind: 'none' }
  /** Something open that this rule never touches (entry side, ours, unreadable): today's OPEN_ORDER_EXISTS. */
  | { kind: 'blocking' }
  /** Every open order is exit-side and cancellable; at least one is the owner's. */
  | { kind: 'cancel'; orders: CancellableOrder[] }
  /** An owner exit-side order is in the way but cannot be cancelled (no order id, too many): visible failure. */
  | { kind: 'uncancellable'; detail: string };

/** A non-terminal row is the owner's exit-side order for a position whose exit is `exitSide`. */
export function isOwnerExitOrder(row: unknown, exitSide: 'BUY' | 'SELL'): boolean {
  const r = row as Row;
  return !isOurs(String(r?.ordertag ?? '').trim()) && up(r?.transactiontype) === exitSide;
}

const toCancellable = (o: Row, owner: boolean): CancellableOrder => ({
  orderId: String(o?.orderid ?? '').trim(),
  variety: up(o?.variety) || 'NORMAL',
  orderType: up(o?.ordertype),
  side: up(o?.transactiontype),
  quantity: numOrNull(o?.quantity) ?? 0,
  status: statusOf(o),
  price: numOrNull(o?.price),
  triggerPrice: numOrNull(o?.triggerprice),
  owner,
});

/**
 * EXIT_CANCEL_OWNER_ORDERS (2026-11-25). The non-terminal orders on the exit's contract (same token +
 * exchange), classified for "cancel, confirm, then exit". `cancel` only when EVERY open order is on the exit
 * side (SELL for a long, BUY for a short) and is either the owner's (no GrW ordertag) — any order type,
 * quantity, product or variety — or, with `cancelOwnStop` (AI_AUTO_EXIT_CANCEL_PROTECTIVE), our own floor stop
 * for this tracker; and at least one is the owner's. An entry-side order, any other order of ours or an
 * unreadable side ⇒ `blocking`: nothing is cancelled (today's rule). Other contracts are never looked at.
 */
export function ownerExitOrdersFor(
  rows: unknown[],
  exit: { exchange: string; token: string; side: 'BUY' | 'SELL'; trackerId: string },
  opts: { cancelOwnStop: boolean },
): OwnerOrderScan {
  const open = (rows as Row[]).filter((o) =>
    String(o?.symboltoken ?? '') === exit.token && up(o?.exchange) === up(exit.exchange) && !isTerminalOrderStatus(statusOf(o)));
  if (open.length === 0) return { kind: 'none' };
  const stopTag = floorStopTag(exit.trackerId);
  const orders: CancellableOrder[] = [];
  for (const o of open) {
    const tag = String(o?.ordertag ?? '').trim();
    const side = up(o?.transactiontype);
    if (side !== 'BUY' && side !== 'SELL') return { kind: 'blocking' };
    if (side !== exit.side) return { kind: 'blocking' };
    if (tag === stopTag) {
      if (!opts.cancelOwnStop) return { kind: 'blocking' };
      orders.push(toCancellable(o, false));
      continue;
    }
    if (isOurs(tag)) return { kind: 'blocking' };
    orders.push(toCancellable(o, true));
  }
  if (!orders.some((o) => o.owner)) return { kind: 'blocking' };
  const noId = orders.filter((o) => o.orderId === '');
  if (noId.length > 0) {
    return { kind: 'uncancellable', detail: `owner exit-side order with no order id (${describeOwnerOrders(noId)}) — cannot be cancelled` };
  }
  if (orders.length > MAX_PROTECTIVE_CANCELS) {
    return { kind: 'uncancellable', detail: `${orders.length} exit-side orders on the contract (${describeOwnerOrders(orders)}) — more than ${MAX_PROTECTIVE_CANCELS} are never cancelled` };
  }
  return { kind: 'cancel', orders };
}

/**
 * The protective scan's orders (AI_AUTO_EXIT_CANCEL_PROTECTIVE) with their price / trigger from the same book
 * and whose they are (`owner` = no GrW ordertag), so a cancelled owner order is recorded on that path too.
 */
export function withOwnerFacts(rows: unknown[], orders: ProtectiveOrder[]): CancellableOrder[] {
  return orders.map((p) => {
    const r = (rows as Row[]).find((o) => String(o?.orderid ?? '').trim() === p.orderId);
    return {
      ...p,
      price: r ? numOrNull(r.price) : null,
      triggerPrice: r ? numOrNull(r.triggerprice) : null,
      owner: r ? !isOurs(String(r.ordertag ?? '').trim()) : false,
    };
  });
}

/** "OWN1 (LIMIT SELL 80 @ 520), SL1 (STOPLOSS_LIMIT SELL 40 @ 449 trg 450)" */
export function describeOwnerOrders(orders: CancellableOrder[]): string {
  return orders.map((o) => {
    const px = o.price != null && o.price > 0 ? ` @ ${o.price}` : '';
    const trg = o.triggerPrice != null && o.triggerPrice > 0 ? ` trg ${o.triggerPrice}` : '';
    return `${o.orderId || '?'} (${o.orderType || '?'} ${o.side} ${o.quantity}${px}${trg})`;
  }).join(', ');
}
