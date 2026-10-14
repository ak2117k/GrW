// apps/api/src/modules/sentinel-executor/domain/claim-timing.ts
import { BROKER_CALL_TIMEOUT_MS } from '../../auto-execution/services/per-user-broker-session.factory';

/** Grace before looking for an order whose placement answer was not definitive (review fix 1). */
export const TAG_LOOKUP_DELAY_MS = 2_000;
/** Cancel protective then exit: order-book checks at +1 s, +3 s, +6 s after the cancel request(s). */
export const CANCEL_CONFIRM_STEPS_MS = [1_000, 2_000, 3_000];
/** More protective orders than this on one contract ⇒ not cancelled (keeps the bound below finite). */
export const MAX_PROTECTIVE_CANCELS = 3;

/**
 * Every broker call one attempt can make while its row is still CLAIMED (it
 * leaves CLAIMED at PLACED or at its terminal status): ephemeral login, the
 * pre-order positions + book reads, up to MAX_PROTECTIVE_CANCELS cancels, the
 * cancel-confirm book reads, the post-cancel positions + book re-check, the
 * MARKET placement, its settle book read, the fallback positions + book reads,
 * the LIMIT placement, its settle book read, and the logout in `finally`.
 */
export const MAX_BROKER_CALLS_WHILE_CLAIMED =
  1 + 2 + MAX_PROTECTIVE_CANCELS + CANCEL_CONFIRM_STEPS_MS.length + 2 + 1 + 1 + 2 + 1 + 1 + 1;

const SLEEPS_WHILE_CLAIMED_MS = CANCEL_CONFIRM_STEPS_MS.reduce((a, b) => a + b, 0) + 2 * TAG_LOOKUP_DELAY_MS;
/** Database writes and scheduling slack on top of the broker worst case. */
const MARGIN_MS = 30_000;

/**
 * A CLAIMED row older than this was cut off mid-flight (plan R8) and is swept to
 * FAILED: INTERRUPTED (never re-sent). Derived from the worst case — every call
 * hitting the 15 s wall-clock cap — so a slow but live attempt is never swept.
 * Shared by the AI poller's boot sweeps and the owner's Exit button.
 */
export const CLAIM_STALE_MS = Math.max(
  180_000,
  MAX_BROKER_CALLS_WHILE_CLAIMED * BROKER_CALL_TIMEOUT_MS + SLEEPS_WHILE_CLAIMED_MS + MARGIN_MS,
);
/** The poller's second boot sweep: after any row claimed just before a restart has gone stale. */
export const SECOND_SWEEP_MS = CLAIM_STALE_MS + 5_000;
