/**
 * True when an error is a benign smartapi-javascript WebSocket failure that must
 * NOT crash the whole Node process. Two classes:
 *
 * 1. Heartbeat race — the library's internal heartbeat timer calls `ws.send()`
 *    without checking readyState, so during the daily reconnect (socket
 *    CONNECTING/CLOSING/CLOSED) the `ws` library throws "WebSocket is not open:
 *    readyState N". Matched by message alone (the text is distinctive).
 *
 * 2. Reconnect handshake/connection failure — at the ~6 AM IST session reset the
 *    feed reconnects and the handshake is rejected, surfacing via the library's
 *    `ws.onerror` as "Unexpected server response: 401" (or 403/5xx), "socket hang
 *    up", ECONNRESET/ETIMEDOUT, etc. Unhandled, this killed the process
 *    (main.ts) — taking the API and every chart/feed down until a manual
 *    restart. The feed must simply retry, not crash the server.
 *
 * Both are swallowed (via uncaughtException AND unhandledRejection) so a
 * third-party library's stray async error can never take down the API. Every
 * OTHER error crashes loudly so real bugs stay visible.
 *
 * Class 2 is deliberately PINNED to the smartapi WS stack so an unrelated
 * network error (a failed HTTP/DB call elsewhere) is never silently swallowed.
 */
export function isBenignWsHeartbeatError(err: unknown): boolean {
  if (err == null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack ?? '' : '';

  // Class 1: heartbeat send on a non-open socket (message is distinctive enough).
  if (msg.includes('WebSocket is not open')) return true;

  // Class 2: broker-feed reconnect failures. Pin to the smartapi WS path so we
  // only swallow errors originating from the Angel One feed socket, never an
  // unrelated network error elsewhere in the app.
  const fromSmartapiWs = /smartapi-javascript|websocket2\.0/i.test(stack);
  if (fromSmartapiWs) {
    if (
      /Unexpected server response: \d+/i.test(msg) || // 401/403/5xx handshake on daily reset
      /socket hang up/i.test(msg) ||
      /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/i.test(msg) ||
      /WebSocket was closed/i.test(msg)
    ) {
      return true;
    }
  }
  return false;
}
