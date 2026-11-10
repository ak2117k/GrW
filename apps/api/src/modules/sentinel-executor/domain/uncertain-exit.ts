// apps/api/src/modules/sentinel-executor/domain/uncertain-exit.ts
import type { QtyUnit } from './auto-exit.types';
import { findOrderFill, type OrderFill } from './exit-fill';
import { aiExitOrderTag, findOrderByTag, isDeadOrderStatus, planExitOrder } from './exit-order';
import { triggerOf } from './manual-exit';

/**
 * Resolving exits of unknown fate (2026-11-10).
 *
 * WHY: an exit's MARKET SELL got `{}` from the SDK (its 7 s timeout), the order book
 * read 2 s later did not show our tag, and the row ended FAILED: ORDER_UNCERTAIN.
 * hasInFlight then blocked EVERY later exit on that position for the rest of the IST
 * day (112 decisions incl. the ₹2k MAX_LOSS hard exit skipped EXIT_IN_FLIGHT for 4 h
 * while the position stayed open). The block is right while the order may exist; it
 * is wrong once the broker shows it does not.
 *
 * This decides, from READ-ONLY broker answers, what such a row really is:
 *  - our ordertag (either leg) live or complete in the book → the order exists (PLACED / FILLED);
 *  - the uncertain leg's tag rejected / cancelled          → REJECTED;
 *  - no row with our tag AND the position still exactly what the exit was sized from
 *    (same side, same quantity), on TWO answered checks ≥ UNCERTAIN_RECHECK_GAP_MS
 *    apart, the first ≥ UNCERTAIN_MIN_AGE_MS after the order was sent
 *                                                          → it never happened (ORDER_NOT_FOUND);
 *  - the position gone or changed                         → something closed it: stay blocked.
 * An unanswered read decides nothing. Pure: no clock, no I/O.
 */

/** FAILED reason of an unknown-fate row the resolver proved was never placed. NOT an unknown-fate reason. */
export const ORDER_NOT_FOUND = 'ORDER_NOT_FOUND';
/** How often the resolver sweeps (its own timer). */
export const UNCERTAIN_RESOLVE_SWEEP_MS = 30_000;
/** Angel's book can lag an order: no "not found" conclusion before this long after the send. */
export const UNCERTAIN_MIN_AGE_MS = 60_000;
/** The two "not found, position intact" checks must be at least this far apart. */
export const UNCERTAIN_RECHECK_GAP_MS = 30_000;
/** Rows checked per sweep (each costs one order-book + one positions read). */
export const UNCERTAIN_PER_SWEEP = 5;

/** The row fields the decision needs (ai_exit_executions). */
export interface UncertainExitRow {
  id: string;
  userId: string;
  verdictId: string;
  trackerId: string;
  symbol: string;
  exchange: string | null;
  token: string | null;
  side: string | null;
  quantity: number | null;
  orderType: string | null;
  reason: string | null;
  brokerMessage: string | null;
  orderSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UncertainDecision =
  /** No change. `keepStreak`: false ⇒ a pending first "not found" no longer counts. */
  | { kind: 'WAIT'; why: string; keepStreak: boolean }
  | { kind: 'NOT_FOUND_FIRST'; detail: string }
  | { kind: 'NOT_PLACED'; detail: string }
  | { kind: 'ORDER_LIVE'; leg: 'M' | 'L'; tag: string; orderId: string; status: string }
  | { kind: 'ORDER_FILLED'; leg: 'M' | 'L'; tag: string; orderId: string; fill: OrderFill }
  | { kind: 'ORDER_DEAD'; leg: 'M' | 'L'; tag: string; orderId: string; status: 'rejected' | 'cancelled'; text: string }
  | { kind: 'POSITION_CHANGED'; detail: string };

/** When the order went out: the recorded send time, else the row's last write (never earlier than the send). */
export function sentReferenceMs(row: Pick<UncertainExitRow, 'orderSentAt' | 'updatedAt'>): number {
  const sent = row.orderSentAt instanceof Date ? row.orderSentAt.getTime() : NaN;
  return Number.isFinite(sent) ? sent : row.updatedAt.getTime();
}

export function decideUncertain(input: {
  row: UncertainExitRow;
  /** Answered order-book rows, or null when the read was not answered. */
  book: unknown[] | null;
  /** Answered positions rows, or null when the read was not answered. */
  positions: unknown[] | null;
  /** AI_AUTO_EXIT_QTY_UNITS for the row's exchange (as the executor sized the order). */
  qtyUnit: QtyUnit | undefined;
  nowMs: number;
  /** When an earlier check of this row first saw "not found, position intact"; null if none pending. */
  firstNotFoundAtMs: number | null;
}): UncertainDecision {
  const { row, book, positions, nowMs, firstNotFoundAtMs } = input;
  // The plan is written before any order is sent; without it the position cannot be compared.
  if (!row.exchange || !row.token || (row.side !== 'BUY' && row.side !== 'SELL') || !row.quantity || row.quantity <= 0) {
    return { kind: 'WAIT', why: 'NO_RECORDED_PLAN', keepStreak: false };
  }
  if (nowMs - sentReferenceMs(row) < UNCERTAIN_MIN_AGE_MS) return { kind: 'WAIT', why: 'TOO_EARLY', keepStreak: true };
  if (book === null) return { kind: 'WAIT', why: 'BOOK_UNANSWERED', keepStreak: true };
  if (positions === null) return { kind: 'WAIT', why: 'POSITIONS_UNANSWERED', keepStreak: true };

  const trigger = triggerOf(row.verdictId);
  const legs = (['M', 'L'] as const).map((leg) => {
    const tag = aiExitOrderTag(row.verdictId, leg, trigger);
    return { leg, tag, mine: findOrderByTag(book, tag) };
  });

  // Either leg live or complete: an order of ours exists — the block is right.
  for (const { leg, tag, mine } of legs) {
    if (!mine || isDeadOrderStatus(mine.status)) continue;
    if (mine.status === 'complete' && mine.orderId) {
      const fill = findOrderFill(book, mine.orderId);
      if (fill) return { kind: 'ORDER_FILLED', leg, tag, orderId: mine.orderId, fill };
    }
    return { kind: 'ORDER_LIVE', leg, tag, orderId: mine.orderId, status: mine.status || 'unknown' };
  }

  // The leg whose answer was uncertain: the LIMIT fallback when the row got that far, else the MARKET.
  const uncertainLeg = String(row.orderType ?? '').toUpperCase() === 'LIMIT' ? 'L' : 'M';
  const u = legs.find((l) => l.leg === uncertainLeg)!;
  if (u.mine) {
    const status = u.mine.status === 'cancelled' ? 'cancelled' : 'rejected';
    return { kind: 'ORDER_DEAD', leg: u.leg, tag: u.tag, orderId: u.mine.orderId, status, text: u.mine.text };
  }

  // No row with our tag. Did the position stay exactly what the exit was sized from?
  const plan = planExitOrder(
    positions,
    { exchange: row.exchange, token: row.token, trackerQty: 0, lotSize: null },
    { mode: 'live', qtyUnit: input.qtyUnit },
  );
  if (!plan.ok) {
    if (plan.reason === 'ALREADY_FLAT') return { kind: 'POSITION_CHANGED', detail: 'the position is flat now' };
    return { kind: 'WAIT', why: `POSITION_UNREADABLE:${plan.reason}`, keepStreak: false };
  }
  if (plan.order.side !== row.side || plan.order.quantity !== row.quantity) {
    return {
      kind: 'POSITION_CHANGED',
      detail: `net qty now ${plan.netQty} (an exit of ${plan.order.side} ${plan.order.quantity}); the uncertain exit was ${row.side} ${row.quantity}`,
    };
  }
  const intact = `no order with tag ${u.tag} in the book; position unchanged (${row.side} ${row.quantity} still open)`;
  if (firstNotFoundAtMs === null) return { kind: 'NOT_FOUND_FIRST', detail: intact };
  if (nowMs - firstNotFoundAtMs < UNCERTAIN_RECHECK_GAP_MS) return { kind: 'WAIT', why: 'RECHECK_TOO_SOON', keepStreak: true };
  return { kind: 'NOT_PLACED', detail: intact };
}
