import { Logger } from '@nestjs/common';
import type { CredentialDecryptor } from '../../credential-vault/execution/credential-decryptor';
import type {
  PerUserBrokerSessionFactory,
  UserBrokerSession,
  UserSmartApiLike,
} from './per-user-broker-session.factory';

/**
 * Reading this user's account now would need an Angel login over a feed session
 * of the SAME account that is between logins. A second login on one client code
 * kills the other session's stream, so the read is refused instead. Thrown
 * before any broker call.
 */
export class OwnSessionUnavailableError extends Error {
  constructor(detail: string) {
    super(`No session on this user's own Angel account is usable without a second login: ${detail}`);
    this.name = 'OwnSessionUnavailableError';
  }
}

/** Which session served the read. */
export type OwnSessionSource = 'user-feed' | 'shared-feed' | 'ephemeral';

/** Structural slices of the collaborators, so callers and tests pass fakes. */
export interface OwnAccountSessionDeps {
  /** UserFeedManager; null/undefined skips the warm per-user tier. */
  userFeeds?: {
    leaseRestClient(userId: string): { client: unknown; clientId: string; release(): void } | null;
    hasSession(userId: string): boolean;
  } | null;
  factory: Pick<PerUserBrokerSessionFactory, 'borrow' | 'withSession'>;
  decryptor: CredentialDecryptor;
  /** AngelOneAuthService — the shared market-data feed (credentials env-first). */
  authService: {
    isAuthenticated(): boolean;
    getSmartApi(): unknown;
    getClientId(): string;
  };
}

const logger = new Logger('OwnAccountSession');
const sameClient = (a: string | undefined, b: string | undefined) => {
  const x = String(a ?? '').trim().toUpperCase();
  return x !== '' && x === String(b ?? '').trim().toUpperCase();
};

/**
 * Run `fn` against a session authenticated with THIS user's own Angel
 * credentials, never a second login over a live feed of the same account.
 *
 *  1. The user's warm per-user feed session (UserFeedManager), leased: no login,
 *     no logout, no decrypt (the sentinel executor's owner-session pattern).
 *  2. Per-user feed session registered but between logins → refuse.
 *  3. Otherwise one vault lease: if the SHARED market-data session
 *     (AngelOneAuthService) is logged in with exactly this user's client code, it
 *     is borrowed (a login would kill it); same client code but not logged in →
 *     refuse. A different (or unknown) client code means the shared session is
 *     ANOTHER account — its credentials resolve env-first (FeedCredentialProvider),
 *     so `isFeedAccount` alone proves nothing — and it is never used: an ephemeral
 *     login with the user's own credentials serves the read.
 *
 * The tier is chosen before any broker call; an error inside a tier propagates
 * and is never retried on another tier (which could mean a second login).
 */
export async function withOwnAccountSession<T>(
  deps: OwnAccountSessionDeps,
  userId: string,
  ctx: Parameters<CredentialDecryptor['withDecryptedCredentials']>[1],
  fn: (session: UserBrokerSession, source: OwnSessionSource) => Promise<T>,
): Promise<T> {
  const warm = deps.userFeeds?.leaseRestClient(userId) ?? null;
  if (warm) {
    try {
      return await deps.factory.borrow(warm.client as UserSmartApiLike, warm.clientId, (s) => fn(s, 'user-feed'));
    } finally {
      warm.release();
    }
  }
  if (deps.userFeeds?.hasSession(userId)) {
    logger.warn(`per-user feed session for ${userId} is between logins — not logging in over it`);
    throw new OwnSessionUnavailableError('the per-user feed session is between logins');
  }
  return deps.decryptor.withDecryptedCredentials(userId, ctx, async (creds) => {
    const sharedClientId = deps.authService.getClientId();
    if (sameClient(sharedClientId, creds.clientId)) {
      if (!deps.authService.isAuthenticated()) {
        throw new OwnSessionUnavailableError('the shared feed session on this account is between logins');
      }
      return deps.factory.borrow(
        deps.authService.getSmartApi() as UserSmartApiLike,
        sharedClientId,
        (s) => fn(s, 'shared-feed'),
      );
    }
    return deps.factory.withSession(creds, (s) => fn(s, 'ephemeral'));
  });
}
