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
