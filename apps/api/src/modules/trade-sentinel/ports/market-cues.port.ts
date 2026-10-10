/**
 * The live packet's read of the market-cues cache.
 *
 * A PORT for the same reason as every other: `ContextPacketService` sits inside
 * the cycle's import graph, which `sentinel-cycle.service.spec.ts` walks for
 * anything that can place an order. The cues service itself reaches nothing of
 * the sort (HTTP to public endpoints only), but the binding still lives in the
 * module's composition root, so this file — types only — is all the cycle sees.
 *
 * `peek` is synchronous and does no I/O: a live heartbeat must never wait on
 * Yahoo or NSE. Whatever the cache holds is shown with its own source time and
 * status; what it does not hold is stated unavailable.
 */
import type { MarketCuesSnapshot } from '../../market-cues/market-cues.types';

export interface MacroCuesReader {
  peek(now: Date): MarketCuesSnapshot;
}

/** DI token — an interface cannot be resolved by type. */
export const MACRO_CUES = 'SENTINEL_MACRO_CUES';
