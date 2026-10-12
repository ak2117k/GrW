import { Inject, Injectable, Logger } from '@nestjs/common';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import {
  PerUserBrokerSessionFactory,
  type UserBrokerSession,
  type UserSmartApiLike,
} from '../../auto-execution/services/per-user-broker-session.factory';
import {
  CREDENTIAL_DECRYPTOR,
  CredentialDecryptor,
} from '../../credential-vault/execution/credential-decryptor';
import type { SessionSource } from '../domain/auto-exit.types';

/**
 * The owner HAS a feed session but it is between logins (socket dropped, re-login
 * in flight or failed), so there is no authenticated client to borrow. Logging in
 * here would be a second Angel login on the same client code and kill the feed, so
 * the provider refuses instead. Thrown before any broker call.
 */
export class FeedSessionNotReadyError extends Error {
  constructor() {
    super('Owner feed session exists but is not logged in right now; refusing a second login');
    this.name = 'FeedSessionNotReadyError';
  }
}

/**
 * The owner has NO feed session and the caller did not allow an ephemeral vault
 * login (dry-run, review fix 3: a rehearsal must never log in to Angel). Thrown
 * before any broker call.
 */
export class NoFeedSessionError extends Error {
  constructor() {
    super('Owner has no feed session and an ephemeral login is not allowed for this attempt');
    this.name = 'NoFeedSessionError';
  }
}

export interface OwnerSessionOptions {
  /**
   * May the provider fall back to an ephemeral vault login when the owner has no
   * feed session at all? Defaults to false (fail-safe); only live mode passes true.
   */
  allowEphemeralLogin?: boolean;
}

/**
 * Plan ruling R1. The owner's account already has a live Angel session — the
 * per-user feed session the market hub pins. A second login on the same client
 * code kills that session's stream, so the executor BORROWS it (no login, no
 * logout; the feed keeps its client). Only when the owner has no feed session at
 * all, AND the caller allowed it (live mode only), does it log in (vault lease,
 * reason ORDER), exactly like auto-execution; otherwise it refuses
 * ({@link NoFeedSessionError}) — dry-run never logs in (review fix 3).
 * When a feed session exists but is between logins, it refuses
 * ({@link FeedSessionNotReadyError}) rather than log in over it.
 * AngelOneAuthService is never used: its credentials are env-first and may
 * belong to a different Angel account.
 *
 * The tier is chosen ONCE, before any broker call. An error inside a tier is
 * propagated, never retried on the other tier.
 */
@Injectable()
export class OwnerBrokerSessionProvider {
  private readonly logger = new Logger(OwnerBrokerSessionProvider.name);

  constructor(
    private readonly userFeeds: UserFeedManager,
    private readonly factory: PerUserBrokerSessionFactory,
    @Inject(CREDENTIAL_DECRYPTOR) private readonly decryptor: CredentialDecryptor,
  ) {}

  async withOwnerSession<T>(
    userId: string,
    fn: (session: UserBrokerSession, source: SessionSource) => Promise<T>,
    opts: OwnerSessionOptions = {},
  ): Promise<T> {
    const warm = this.userFeeds.warmRestClient(userId);
    if (warm) {
      return this.factory.borrow(warm.client as UserSmartApiLike, warm.clientId, (s) => fn(s, 'user-feed'));
    }
    if (this.userFeeds.hasSession(userId)) {
      this.logger.warn(`[ai-exit] feed session for ${userId} is between logins — not logging in over it`);
      throw new FeedSessionNotReadyError();
    }
    if (opts.allowEphemeralLogin !== true) {
      throw new NoFeedSessionError();
    }
    this.logger.warn(`[ai-exit] no feed session for ${userId} — using an ephemeral login`);
    return this.decryptor.withDecryptedCredentials(userId, { reason: 'ORDER' }, (creds) =>
      this.factory.withSession(creds, (s) => fn(s, 'ephemeral')),
    );
  }
}
