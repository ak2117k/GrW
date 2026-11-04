import type { CarryCloseWindow } from '../services/square-off-look';

/**
 * CLOSE PRODUCTS — what the cycle needs to know about a position's product at the close
 * (intraday carry, spec 2026-11-04 §5.1 / §5.3).
 *
 * The tracker row has no product column: the product (INTRADAY / CARRYFORWARD / DELIVERY) is
 * only on Angel's position book. The live implementation is a cache the intraday-carry service
 * fills from warm position-book reads (no login); the paper cycle answers from the paper trade's
 * own product. Synchronous on purpose: the cycle never waits on a broker read.
 *
 * `productType` null = unknown ⇒ the cycle behaves exactly as before 2026-11-04.
 * `carry` non-null ⇒ an INTRADAY F&O position gets the CARRY/EXIT look in that window.
 * Imports nothing that reaches a broker (the cycle's Stage-0 isolation property).
 */
export const CLOSE_PRODUCTS = 'SENTINEL_CLOSE_PRODUCTS';

export interface CloseContext {
  productType: string | null;
  carry: CarryCloseWindow | null;
}

export interface CloseProductLookup {
  closeContextFor(entry: { userId: string; trackerId: string; exchange: string }): CloseContext;
}

/** Nothing known: the pre-2026-11-04 behaviour. */
export const NO_CLOSE_CONTEXT: CloseContext = { productType: null, carry: null };
