/**
 * Retry policy for a socket.io namespace the SERVER disconnects.
 *
 * socket.io treats "io server disconnect" as terminal and never retries on its
 * own, so we do it by hand — with a cap, so a namespace that will never accept
 * us cannot hot-loop.
 *
 * The cap needs care. `/ws/telegram` (and the other ADMIN-only gateways) accept
 * the handshake and only then reject inside `handleConnection`, so the client
 * genuinely sees 'connect' before 'disconnect' on every single attempt.
 * Resetting the retry counter on 'connect' therefore reset it on every FAILURE,
 * and a non-admin user produced an endless connect/disconnect loop.
 *
 * So success is defined by DURATION, not by the 'connect' event: only a
 * connection that stays up past `STABLE_CONNECTION_MS` clears the counter.
 */

/** Attempts allowed before we stop retrying a server-rejected namespace. */
export const SERVER_DROP_MAX_RETRIES = 10;

/** A connection must outlive this to count as genuinely established. */
export const STABLE_CONNECTION_MS = 5_000;

/** Longest gap between retries. */
const MAX_RETRY_DELAY_MS = 5_000;

/**
 * Did this connection last long enough to count as a success (and so clear the
 * retry counter)? Must EXCEED the threshold — an instant accept-then-reject is
 * a failure however the events are ordered.
 */
export function shouldResetRetries(connectedForMs: number): boolean {
  return connectedForMs > STABLE_CONNECTION_MS;
}

/** Retry only while we hold a token (else the user is logged out) and are under the cap. */
export function shouldRetryServerDisconnect(opts: {
  hasToken: boolean;
  retries: number;
}): boolean {
  return opts.hasToken && opts.retries < SERVER_DROP_MAX_RETRIES;
}

/** Linear back-off, capped. Always positive so a retry is never scheduled at 0ms. */
export function nextRetryDelayMs(retries: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * Math.max(1, retries));
}

/**
 * Shortest gap between recovery attempts.
 *
 * `visibilitychange` fires on every tab flick and `online` can flap on a poor
 * connection. Without a floor, re-arming on each one would rebuild exactly the
 * hot loop {@link SERVER_DROP_MAX_RETRIES} exists to prevent.
 */
export const RECOVERY_COOLDOWN_MS = 10_000;

/**
 * Should a tab-return or `online` event re-arm a socket that has given up?
 *
 * The retry cap makes a rejected namespace go quiet, which is right — but it
 * also means a socket that exhausted the cap stays dead for the remainder of
 * the session, and the user's only recovery is a page refresh. Returning to the
 * tab, or the network coming back, is NEW information: the reason the retries
 * failed may no longer hold. So the budget is refreshed, but only behind a
 * token check (no token means logged out, and staying down is correct) and a
 * cooldown (so a burst of events cannot spin).
 */
export function shouldAttemptRecovery(opts: {
  hasToken: boolean;
  msSinceLastAttempt: number;
}): boolean {
  return opts.hasToken && opts.msSinceLastAttempt >= RECOVERY_COOLDOWN_MS;
}
