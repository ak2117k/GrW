import { describe, expect, it } from 'vitest';
import {
  SERVER_DROP_MAX_RETRIES,
  STABLE_CONNECTION_MS,
  nextRetryDelayMs,
  shouldResetRetries,
  shouldAttemptRecovery,
  shouldRetryServerDisconnect,
} from './ws-retry';

/**
 * Retry policy for a namespace the server disconnects.
 *
 * socket.io treats "io server disconnect" as terminal, so we retry by hand. The
 * cap exists to stop a permanently-rejected namespace hot-looping — but the cap
 * was defeated in practice: `/ws/telegram` is ADMIN-only, and a non-admin socket
 * COMPLETES the handshake (firing 'connect') before `handleConnection` rejects
 * it. Resetting the counter on 'connect' therefore reset it on every failed
 * attempt, giving an unbounded connect/disconnect loop.
 *
 * Fix: only a connection that STAYS UP counts as success.
 */
describe('shouldResetRetries', () => {
  it('resets after a connection that stayed up', () => {
    expect(shouldResetRetries(STABLE_CONNECTION_MS + 1)).toBe(true);
  });

  it('does NOT reset for a connection dropped immediately', () => {
    // The /ws/telegram case: connect -> reject, milliseconds apart.
    expect(shouldResetRetries(5)).toBe(false);
  });

  it('does NOT reset exactly at the threshold (must exceed it)', () => {
    expect(shouldResetRetries(STABLE_CONNECTION_MS)).toBe(false);
  });

  it('does not reset for a zero-length connection', () => {
    expect(shouldResetRetries(0)).toBe(false);
  });
});

describe('shouldRetryServerDisconnect', () => {
  it('retries while under the cap and holding a token', () => {
    expect(shouldRetryServerDisconnect({ hasToken: true, retries: 0 })).toBe(true);
    expect(
      shouldRetryServerDisconnect({ hasToken: true, retries: SERVER_DROP_MAX_RETRIES - 1 }),
    ).toBe(true);
  });

  it('stops at the cap — a permanently-rejected namespace must go quiet', () => {
    expect(
      shouldRetryServerDisconnect({ hasToken: true, retries: SERVER_DROP_MAX_RETRIES }),
    ).toBe(false);
  });

  it('stops past the cap', () => {
    expect(
      shouldRetryServerDisconnect({ hasToken: true, retries: SERVER_DROP_MAX_RETRIES + 5 }),
    ).toBe(false);
  });

  it('never retries without a token — that is a logged-out user, not a glitch', () => {
    expect(shouldRetryServerDisconnect({ hasToken: false, retries: 0 })).toBe(false);
  });
});

describe('nextRetryDelayMs', () => {
  it('backs off as retries accumulate', () => {
    expect(nextRetryDelayMs(1)).toBeLessThan(nextRetryDelayMs(3));
  });

  it('caps the delay', () => {
    expect(nextRetryDelayMs(100)).toBe(5000);
  });

  it('never returns a zero/negative delay', () => {
    expect(nextRetryDelayMs(0)).toBeGreaterThan(0);
  });
});

describe('shouldAttemptRecovery', () => {
  // socket.io gives up permanently on "io server disconnect", and our own
  // retry is capped so a rejected namespace goes quiet. Correct, but it means
  // a socket that exhausted the cap stays dead for the WHOLE session — the
  // user's only recovery is F5. Tab-return and `online` are precisely the
  // moments a previously hopeless retry starts working, so they re-arm it.

  it('retries when the tab returns and we still hold a token', () => {
    expect(
      shouldAttemptRecovery({ hasToken: true, msSinceLastAttempt: 60_000 }),
    ).toBe(true);
  });

  it('stays down with no token — the user is logged out', () => {
    expect(
      shouldAttemptRecovery({ hasToken: false, msSinceLastAttempt: 60_000 }),
    ).toBe(false);
  });

  it('ignores a burst of triggers inside the cooldown', () => {
    // visibilitychange can fire repeatedly while a user flicks between tabs,
    // and `online` can flap. Re-arming on every one of those would rebuild the
    // hot loop the retry cap exists to prevent.
    expect(
      shouldAttemptRecovery({ hasToken: true, msSinceLastAttempt: 500 }),
    ).toBe(false);
  });

  it('allows the very first attempt', () => {
    expect(
      shouldAttemptRecovery({ hasToken: true, msSinceLastAttempt: Number.POSITIVE_INFINITY }),
    ).toBe(true);
  });
});
