import type { CoreOrder } from '../execution/execution.types';
import { isOpenState } from '../execution/order-state';
import type { CorePositionStatus } from './lifecycle.types';

/** Spec §7.1. PENDING_ENTRY may jump ahead (a fill and an exit can land between two re-reads). */
const NEXT: Readonly<Record<CorePositionStatus, readonly CorePositionStatus[]>> = {
  PENDING_ENTRY: ['OPEN', 'PARTIAL', 'EXITING', 'CLOSED', 'CANCELLED'],
  OPEN: ['PARTIAL', 'EXITING', 'CLOSED'],
  PARTIAL: ['EXITING', 'CLOSED'],
  EXITING: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

export function canMove(from: CorePositionStatus, to: CorePositionStatus): boolean {
  return from === to || NEXT[from].includes(to);
}

export interface PositionFacts {
  status: CorePositionStatus;
  entryFilledQty: number;
  exitFilledQty: number;
  openQty: number;
  entryAvgPrice: number | null;
  /** The entry order while it can still fill. */
  openEntry: CoreOrder | null;
  openExits: CoreOrder[];
  /** The unfilled quantity of the open exit orders. */
  pendingExitQty: number;
}

/**
 * The position's quantities and status from its own orders (ruling L2): the order table
 * is the only source of quantities. EXITING is sticky (a decision, not a quantity) until
 * the position is flat with nothing open; terminal statuses never move.
 */
export function reducePosition(current: CorePositionStatus, orders: readonly CoreOrder[]): PositionFacts {
  const entry = orders.find((o) => o.purpose === 'ENTRY') ?? null;
  const exits = orders.filter((o) => o.purpose === 'EXIT');
  const entryFilledQty = entry?.filledQty ?? 0;
  const exitFilledQty = exits.reduce((n, o) => n + o.filledQty, 0);
  const openQty = entryFilledQty - exitFilledQty;
  if (openQty < 0) throw new Error(`exits filled ${exitFilledQty} > entry filled ${entryFilledQty}`);
  const openEntry = entry && isOpenState(entry.state) ? entry : null;
  const openExits = exits.filter((o) => isOpenState(o.state));
  const pendingExitQty = openExits.reduce((n, o) => n + o.qty - o.filledQty, 0);
  const facts = { entryFilledQty, exitFilledQty, openQty, entryAvgPrice: entry?.avgFillPrice ?? null, openEntry, openExits, pendingExitQty };
  return { ...facts, status: nextStatus(current, entry, facts) };
}

function nextStatus(
  current: CorePositionStatus,
  entry: CoreOrder | null,
  f: Pick<PositionFacts, 'entryFilledQty' | 'exitFilledQty' | 'openQty' | 'openEntry' | 'openExits'>,
): CorePositionStatus {
  if (current === 'CLOSED' || current === 'CANCELLED') return current;
  if (f.entryFilledQty === 0) return entry && !f.openEntry ? 'CANCELLED' : current;
  if (f.openQty === 0 && !f.openEntry && f.openExits.length === 0) return 'CLOSED';
  if (current === 'EXITING') return 'EXITING';
  return f.exitFilledQty > 0 ? 'PARTIAL' : 'OPEN';
}
