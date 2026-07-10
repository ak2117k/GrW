import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  CREDENTIAL_DECRYPTOR,
  CredentialDecryptor,
} from '../../credential-vault/execution/credential-decryptor';
// Reuse the exact 5-field decrypted-cred shape the per-user order session uses,
// rather than redefining it — the vault decryptor yields the same fields.
import { AngelOneCreds } from '../../auto-execution/services/per-user-broker-session.factory';

/** Env placeholders that mean "credentials not configured" (matches AngelOneAuthService). */
const API_KEY_PLACEHOLDER = 'your_api_key_here';
const CLIENT_ID_PLACEHOLDER = 'your_client_id_here';

/**
 * Raised by {@link FeedCredentialProvider.withFeedCredentials} when neither env
 * creds nor a designated vault feed account are available — the shared feed has
 * nothing to log in with (caller falls back to demo/REST data, never crashes).
 */
export class NoFeedCredentialsError extends Error {
  constructor(message = 'No Angel One feed credentials configured (env or vault feed account)') {
    super(message);
    this.name = 'NoFeedCredentialsError';
  }
}

/**
 * Single-purpose resolver for the ONE Angel One account that powers the shared
 * market-data feed (vault→market-feed bridge, spec §3.1).
 *
 * Resolution order is **env wins → vault fallback → none**:
 *   1. ENV   — if `ANGEL_ONE_API_KEY`/`ANGEL_ONE_CLIENT_ID` are set, non-empty,
 *              and not the `your_*_here` placeholders, use env creds directly
 *              (the optional dedicated "house account"). No vault touch.
 *   2. VAULT — else the single user flagged `isFeedAccount = true` that also has
 *              a `brokerCredential`, leased via the existing
 *              `CredentialDecryptor.withDecryptedCredentials(... reason:'FEED')`
 *              so decrypt→use→zeroize stays owned by the vault boundary.
 *   3. NONE  — else throw {@link NoFeedCredentialsError}.
 *
 * Never logs, persists, or returns secret values; it only hands them to the
 * caller's `use` callback inside a bounded lease.
 */
@Injectable()
export class FeedCredentialProvider {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(CREDENTIAL_DECRYPTOR) private readonly credentialDecryptor: CredentialDecryptor,
  ) {}

  /**
   * Run `use` with the feed account's credentials inside a bounded lease. For the
   * env path the creds are passed directly; for the vault path the underlying
   * decryptor lease zeroizes them once `use` settles. Throws
   * {@link NoFeedCredentialsError} when no feed creds exist anywhere.
   */
  async withFeedCredentials<T>(use: (creds: AngelOneCreds) => Promise<T>): Promise<T> {
    const envCreds = this.resolveEnvCreds();
    if (envCreds) {
      return use(envCreds);
    }

    const feedUserId = await this.findFeedAccountUserId();
    if (feedUserId) {
      return this.credentialDecryptor.withDecryptedCredentials(feedUserId, { reason: 'FEED' }, use);
    }

    throw new NoFeedCredentialsError();
  }

  /**
   * Cheap presence check used by `onModuleInit` to decide whether to attempt a
   * feed login. True if env creds are present OR a designated feed-account user
   * with a `brokerCredential` exists. Never decrypts anything.
   */
  async hasFeedCredentials(): Promise<boolean> {
    if (this.resolveEnvCreds()) {
      return true;
    }
    return (await this.findFeedAccountUserId()) !== null;
  }

  /**
   * Build {@link AngelOneCreds} from env, or `null` if env is not meaningfully
   * configured. Env is "present" only when API key and client id are both set,
   * non-empty, and not the placeholders (matches `AngelOneAuthService`).
   */
  private resolveEnvCreds(): AngelOneCreds | null {
    const apiKey = this.configService.get<string>('ANGEL_ONE_API_KEY', API_KEY_PLACEHOLDER);
    const clientId = this.configService.get<string>('ANGEL_ONE_CLIENT_ID', CLIENT_ID_PLACEHOLDER);

    if (
      !apiKey ||
      !clientId ||
      apiKey === API_KEY_PLACEHOLDER ||
      clientId === CLIENT_ID_PLACEHOLDER
    ) {
      return null;
    }

    return {
      apiKey,
      // Angel One's live login does not require the API secret; default to '' when
      // the (optional) ANGEL_ONE_API_SECRET var is absent.
      apiSecret: this.configService.get<string>('ANGEL_ONE_API_SECRET', ''),
      clientId,
      password: this.configService.get<string>('ANGEL_ONE_PASSWORD', ''),
      totpSecret: this.configService.get<string>('ANGEL_ONE_TOTP_SECRET', ''),
    };
  }

  /**
   * Find the id of the sole user flagged `isFeedAccount = true` that also has a
   * `brokerCredential` to decrypt, or `null`. A partial unique index guarantees
   * at most one such user. Selects only the id — no credential material.
   */
  private async findFeedAccountUserId(): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where: { isFeedAccount: true, brokerCredential: { isNot: null } },
      select: { id: true },
    });
    return user?.id ?? null;
  }
}
