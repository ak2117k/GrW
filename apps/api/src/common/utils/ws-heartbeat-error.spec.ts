import { isBenignWsHeartbeatError } from './ws-heartbeat-error';

describe('isBenignWsHeartbeatError', () => {
  it('matches the smartapi heartbeat throw on a CONNECTING socket (readyState 0)', () => {
    expect(isBenignWsHeartbeatError(new Error('WebSocket is not open: readyState 0 (CONNECTING)'))).toBe(true);
  });

  it('matches CLOSING/CLOSED sockets too (readyState 2 / 3) — the reconnect cases the old guard missed', () => {
    expect(isBenignWsHeartbeatError(new Error('WebSocket is not open: readyState 2 (CLOSING)'))).toBe(true);
    expect(isBenignWsHeartbeatError(new Error('WebSocket is not open: readyState 3 (CLOSED)'))).toBe(true);
  });

  it('matches a bare "WebSocket is not open" message with no readyState suffix', () => {
    expect(isBenignWsHeartbeatError(new Error('WebSocket is not open'))).toBe(true);
  });

  it('matches a non-Error reason carrying the same text (unhandledRejection path)', () => {
    expect(isBenignWsHeartbeatError('WebSocket is not open: readyState 3')).toBe(true);
  });

  it('does NOT match unrelated errors — real bugs must still crash loudly', () => {
    expect(isBenignWsHeartbeatError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isBenignWsHeartbeatError(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('handles null / undefined safely', () => {
    expect(isBenignWsHeartbeatError(null)).toBe(false);
    expect(isBenignWsHeartbeatError(undefined)).toBe(false);
  });

  /** Build an error whose stack points at the smartapi WS path (the daily-reset crash origin). */
  function smartapiWsError(message: string): Error {
    const e = new Error(message);
    e.stack =
      `Error: ${message}\n` +
      '    at ws.onerror (C:\\app\\node_modules\\.pnpm\\smartapi-javascript@1.0.27\\node_modules\\smartapi-javascript\\lib\\websocket2.0.js:89:15)\n' +
      '    at callListener (C:\\app\\node_modules\\.pnpm\\ws@8.20.0\\node_modules\\ws\\lib\\event-target.js:290:14)';
    return e;
  }

  it('swallows the daily-reset WS handshake 401 from the smartapi feed (the crash we hit)', () => {
    expect(isBenignWsHeartbeatError(smartapiWsError('Unexpected server response: 401'))).toBe(true);
  });

  it('swallows other smartapi WS reconnect failures (403/5xx, socket hang up, ECONNRESET)', () => {
    expect(isBenignWsHeartbeatError(smartapiWsError('Unexpected server response: 403'))).toBe(true);
    expect(isBenignWsHeartbeatError(smartapiWsError('Unexpected server response: 503'))).toBe(true);
    expect(isBenignWsHeartbeatError(smartapiWsError('socket hang up'))).toBe(true);
    expect(isBenignWsHeartbeatError(smartapiWsError('read ECONNRESET'))).toBe(true);
  });

  it('does NOT swallow the same network errors when they are NOT from the smartapi WS path', () => {
    // An identical 401 / ECONNRESET from an unrelated HTTP/DB call must still crash loudly.
    expect(isBenignWsHeartbeatError(new Error('Unexpected server response: 401'))).toBe(false);
    const dbErr = new Error('read ECONNRESET');
    dbErr.stack = 'Error: read ECONNRESET\n    at TCP.onStreamRead (node:internal/stream_base_commons)';
    expect(isBenignWsHeartbeatError(dbErr)).toBe(false);
  });
});
