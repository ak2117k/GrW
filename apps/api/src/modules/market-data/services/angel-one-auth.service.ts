import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// @ts-ignore — smartapi-javascript has no type declarations
import { SmartAPI } from 'smartapi-javascript';
// RFC-6238 TOTP extracted to a shared util (TDA-005) so the live login here and
// the per-user AngelOneValidator produce codes identically.
import { generateTOTP } from '../utils/angel-one-totp';
import { FeedCredentialProvider } from './feed-credential-provider';
import { withAngelLogin } from './angel-login-gate';
import { sendOpsAlert } from '../../../common/utils/ops-alert';

/**
 * How long a BOOT job waits for the shared feed session before giving up
 * (see {@link AngelOneAuthService.whenAuthenticated}).
 *
 * The feed login is detached from boot (it must not gate the port bind), so
 * every detached boot job that needs the broker starts out racing it — and on
 * 2026-10-12 DailyBackfillWorker lost, hitting the broker ~1s after container
 * start with no client ("Cannot read properties of null (reading
 * 'getCandleData')"). A login is three attempts with 2s + 4s backoff plus
 * broker round trips; two minutes covers a slow broker without letting a dead
 * one hold a boot job forever. The wait ends early if the login settles
 * without a session (no feed account configured).
 */
export const BOOT_SESSION_WAIT_MS = 120_000;

@Injectable()
export class AngelOneAuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AngelOneAuthService.name);

  private smartApi: any = null;
  private jwtToken: string | null = null;
  private refreshTokenValue: string | null = null;
  private feedToken: string | null = null;
  private tokenExpiresAt: Date | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private authenticated = false;

  /**
   * The detached boot login (see onModuleInit). Held so boot jobs can wait on
   * it via {@link whenAuthenticated} and stop waiting the moment it gives up,
   * instead of racing it. Null until onModuleInit runs.
   */
  private bootLogin: Promise<void> | null = null;

  // The feed account's NON-secret identifiers, set at login() from the leased
  // credentials. The raw password / TOTP secret are NEVER stored on the instance —
  // they live only inside the FeedCredentialProvider lease and are zeroized on
  // exit. Only the ~24h session (jwt/feed token + the authenticated SmartAPI
  // client, which holds the JWT internally) is held warm.
  private apiKey = '';
  private clientId = '';

  private static readonly MAX_LOGIN_RETRIES = 3;
  /**
   * After the boot login gives up, keep trying in the background instead of
   * leaving the shared feed dead until the 08:45 IST cron (prod 2026-10-19: down
   * ~10 min until a manual restart). Minutes; the last value repeats.
   */
  private static readonly BACKGROUND_RETRY_MIN = [1, 2, 5, 10, 15];
  private backgroundRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundRetries = 0;
  private static readonly RETRY_DELAY_MS = 2000;
  /** Refresh 1 hour before expiry (tokens last ~24hrs) */
  private static readonly TOKEN_REFRESH_BUFFER_MS = 60 * 60 * 1000;

  // Credential resolution (env-first, vault fallback) is delegated to the
  // FeedCredentialProvider; this service only owns the session lifecycle.
  constructor(private readonly feedCredentials: FeedCredentialProvider) {}

  /**
   * DELIBERATELY NOT AWAITED — the port bind depends on it.
   *
   * Nest awaits every `onModuleInit` before `app.listen()`, so awaiting the
   * broker login put a network round trip in front of the port: three attempts
   * with 6s of backoff between them, and no timeout on the SmartAPI call
   * itself. A broker that is slow, rate-limiting this IP, or simply not
   * answering therefore did not degrade the feed — it stopped the API from
   * opening a port at all, and Render failed the deploy with "no open ports
   * detected".
   *
   * That is the wrong dependency direction. The catch below already states the
   * policy — live market data is non-critical to boot and degrades to demo/REST
   * data — so it must not be able to gate the port either.
   */
  onModuleInit(): void {
    this.bootLogin = this.autoLogin();
  }

  /**
   * Wait (bounded) for the feed session — for BOOT JOBS that need the shared
   * client.
   *
   * WHY: the boot login above is detached so it cannot gate the port, which
   * means every other detached boot job starts out racing it. On 2026-10-12 the
   * DailyBackfillWorker boot pass reached the broker ~1s before the client
   * existed and died with "Cannot read properties of null (reading
   * 'getCandleData')". Jobs that need a session await this instead.
   *
   * Resolves `true` as soon as a session exists. Resolves `false` when
   * `timeoutMs` elapses, or as soon as the boot login has SETTLED without a
   * session (no feed credentials, or every retry failed) — there is nothing
   * left to wait for then, so a feed-less deployment does not stall its boot
   * jobs for the full timeout. Never rejects.
   */
  async whenAuthenticated(timeoutMs: number, pollMs = 1_000): Promise<boolean> {
    if (this.isAuthenticated()) return true;

    // autoLogin never rejects (it catches everything), but guard both arms.
    let bootLoginSettled = false;
    const markSettled = (): void => {
      bootLoginSettled = true;
    };
    void this.bootLogin?.then(markSettled, markSettled);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now())));
        timer.unref?.();
      });
      if (this.isAuthenticated()) return true;
      if (bootLoginSettled) return false;
    }
    return this.isAuthenticated();
  }

  private async autoLogin(): Promise<void> {
    // Only attempt auto-login when a feed account is resolvable (env creds set,
    // or a designated vault account with connected credentials). Otherwise skip
    // gracefully — the feed serves demo/REST data until one is configured.
    try {
      if (!(await this.feedCredentials.hasFeedCredentials())) {
        this.logger.warn(
          'No market-data feed credentials configured (env or designated vault ' +
          'account) — skipping auto-login. Live market data unavailable until a ' +
          'feed account is set.',
        );
        return;
      }

      await this.login();
      this.logger.log('Auto-login succeeded');
    } catch (error) {
      if (await this.feedCredentials.hasFeedCredentials().catch(() => false)) {
        this.scheduleBackgroundLogin(error);
      }
      // NEVER let feed-credential resolution or login crash app bootstrap — the
      // market feed is non-critical to boot and degrades to demo/REST data. This
      // also survives a not-yet-applied migration (a missing isFeedAccount column
      // makes hasFeedCredentials() throw) instead of taking the entire API down.
      this.logger.error(
        `Market-data feed auto-login skipped: ${error instanceof Error ? error.message : error}. ` +
        'Live market data unavailable until resolved (feed serves demo/REST data).',
      );
    }
  }

  onModuleDestroy(): void {
    this.clearRefreshTimer();
    if (this.backgroundRetryTimer) clearTimeout(this.backgroundRetryTimer);
    this.backgroundRetryTimer = null;
  }

  /** Background re-login after a failed boot login: 1, 2, 5, 10, then every 15 min until it works. */
  private scheduleBackgroundLogin(cause: unknown): void {
    if (this.backgroundRetryTimer) return;
    const steps = AngelOneAuthService.BACKGROUND_RETRY_MIN;
    const minutes = steps[Math.min(this.backgroundRetries, steps.length - 1)];
    if (this.backgroundRetries === 0) {
      void sendOpsAlert(
        'angel-shared-login',
        `GrW: shared Angel market-data login FAILED at boot (${cause instanceof Error ? cause.message : cause}). Retrying in the background.`,
      );
    }
    this.backgroundRetryTimer = setTimeout(() => {
      this.backgroundRetryTimer = null;
      this.backgroundRetries += 1;
      this.login().then(
        () => {
          this.logger.log(`Background re-login succeeded after ${this.backgroundRetries} retr${this.backgroundRetries === 1 ? 'y' : 'ies'}`);
          void sendOpsAlert('angel-shared-login-ok', 'GrW: shared Angel market-data login recovered.');
          this.backgroundRetries = 0;
        },
        (err) => {
          this.logger.warn(`Background re-login ${this.backgroundRetries} failed: ${err instanceof Error ? err.message : err}`);
          this.scheduleBackgroundLogin(err);
        },
      );
    }, minutes * 60_000);
    this.backgroundRetryTimer.unref?.();
  }

  /**
   * Authenticate with Angel One SmartAPI using TOTP-based login.
   *
   * Credentials are LEASED from the {@link FeedCredentialProvider} for the
   * duration of the login only: the SmartAPI client is (re)built from the leased
   * api key, `generateSession` is retried up to 3× within the lease (a fresh TOTP
   * per attempt), and the raw password/TOTP secret are zeroized when the lease
   * returns. On success only the session (jwt/refresh/feed tokens + the
   * authenticated client) survives.
   */
  async login(): Promise<void> {
    await this.feedCredentials.withFeedCredentials(async (creds) => {
      // Build the client from the feed account's api key; it retains the JWT
      // internally after generateSession, so it is the warm session handle.
      this.smartApi = new SmartAPI({ api_key: creds.apiKey });
      this.apiKey = creds.apiKey;
      this.clientId = creds.clientId;

      let lastError: Error | undefined;

      for (let attempt = 1; attempt <= AngelOneAuthService.MAX_LOGIN_RETRIES; attempt++) {
        try {
          this.logger.log(`Login attempt ${attempt}/${AngelOneAuthService.MAX_LOGIN_RETRIES}`);

          // Gated: never two logins of this client code at once or in one TOTP
          // step (the per-user feed session may be the same Angel user).
          const session: any = await withAngelLogin<any>(creds.clientId, () =>
            this.smartApi.generateSession(creds.clientId, creds.password, generateTOTP(creds.totpSecret)),
          );

          if (!session?.data?.jwtToken) {
            throw new Error(
              `Invalid session response: ${JSON.stringify(session?.message ?? session)}`,
            );
          }

          this.jwtToken = session.data.jwtToken;
          this.refreshTokenValue = session.data.refreshToken;
          this.feedToken = session.data.feedToken;
          this.authenticated = true;

          // Tokens last ~24 hours
          this.tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

          this.scheduleTokenRefresh();
          this.logger.log('Successfully authenticated with Angel One SmartAPI');
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          this.logger.warn(
            `Login attempt ${attempt} failed: ${lastError.message}`,
          );

          if (attempt < AngelOneAuthService.MAX_LOGIN_RETRIES) {
            await this.delay(AngelOneAuthService.RETRY_DELAY_MS * attempt);
          }
        }
      }

      this.authenticated = false;
      throw new Error(
        `Angel One login failed after ${AngelOneAuthService.MAX_LOGIN_RETRIES} attempts: ${lastError?.message}`,
      );
    });
  }

  /**
   * Refresh the JWT token using the stored refresh token.
   */
  async refreshToken(): Promise<void> {
    try {
      if (!this.refreshTokenValue) {
        this.logger.warn('No refresh token available, performing full login');
        await this.login();
        return;
      }

      this.logger.log('Refreshing Angel One auth token');
      const response = await this.smartApi.generateToken(this.refreshTokenValue);

      if (!response?.data?.jwtToken) {
        throw new Error(
          `Token refresh failed: ${JSON.stringify(response?.message ?? response)}`,
        );
      }

      this.jwtToken = response.data.jwtToken;
      this.refreshTokenValue = response.data.refreshToken ?? this.refreshTokenValue;
      this.feedToken = response.data.feedToken ?? this.feedToken;
      this.tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      this.authenticated = true;

      this.scheduleTokenRefresh();
      this.logger.log('Token refreshed successfully');
    } catch (error) {
      this.logger.error(
        `Token refresh failed: ${error instanceof Error ? error.message : error}`,
      );
      this.logger.log('Falling back to full re-login');
      await this.login();
    }
  }

  /**
   * Get the current JWT auth token.
   * Throws if not authenticated.
   */
  getAuthToken(): string {
    if (!this.jwtToken) {
      throw new Error('Not authenticated. Call login() first.');
    }
    return this.jwtToken;
  }

  /**
   * Get the feed token required for WebSocket connections.
   */
  getFeedToken(): string {
    if (!this.feedToken) {
      throw new Error('Not authenticated. Call login() first.');
    }
    return this.feedToken;
  }

  /**
   * Get the SmartAPI instance for making REST calls.
   *
   * Throws `Not authenticated. Call login() first.` when there is no session —
   * the same error every other accessor here throws, and the message
   * `isNotAuthenticatedError` (and so the NO_FEED_SESSION warning) keys on. It
   * used to return the raw field, which is `null` until the first login, so a
   * caller that got here early failed with an anonymous "Cannot read properties
   * of null (reading 'getCandleData')" that no handler recognised as "no
   * session".
   */
  getSmartApi(): any {
    if (!this.smartApi || !this.isAuthenticated()) {
      throw new Error('Not authenticated. Call login() first.');
    }
    return this.smartApi;
  }

  /** Account profile (name, email, exchanges, products). Requires an active session. */
  async getProfile(): Promise<any> {
    this.assertAuthenticated();
    return this.smartApi.getProfile();
  }

  /** Risk-management squareoff / funds + margin (RMS). Requires an active session. */
  async getRMS(): Promise<any> {
    this.assertAuthenticated();
    return this.smartApi.getRMS();
  }

  /** Today's order book. Requires an active session. */
  async getOrderBook(): Promise<any> {
    this.assertAuthenticated();
    return this.smartApi.getOrderBook();
  }

  private assertAuthenticated(): void {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated. Call login() first.');
    }
  }

  /**
   * Get the client ID.
   */
  getClientId(): string {
    return this.clientId;
  }

  /**
   * Get the API key.
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Check whether the service is currently authenticated.
   */
  isAuthenticated(): boolean {
    if (!this.authenticated || !this.jwtToken) {
      return false;
    }
    if (this.tokenExpiresAt && new Date() >= this.tokenExpiresAt) {
      this.authenticated = false;
      return false;
    }
    return true;
  }

  /**
   * Logout and clear all stored tokens.
   */
  async logout(): Promise<void> {
    try {
      if (this.smartApi) {
        await this.smartApi.logout(this.clientId);
      }
    } catch (error) {
      this.logger.warn(
        `Logout API call failed: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      this.clearSession();
    }
  }

  private clearSession(): void {
    this.jwtToken = null;
    this.refreshTokenValue = null;
    this.feedToken = null;
    this.tokenExpiresAt = null;
    this.authenticated = false;
    this.clearRefreshTimer();
  }

  private scheduleTokenRefresh(): void {
    this.clearRefreshTimer();

    if (!this.tokenExpiresAt) return;

    const refreshIn = Math.max(
      this.tokenExpiresAt.getTime() -
        Date.now() -
        AngelOneAuthService.TOKEN_REFRESH_BUFFER_MS,
      60_000, // minimum 1 minute
    );

    this.logger.log(
      `Token refresh scheduled in ${Math.round(refreshIn / 60_000)} minutes`,
    );

    this.refreshTimer = setTimeout(() => {
      this.refreshToken().catch((err) => {
        this.logger.error(`Scheduled token refresh failed: ${err.message}`);
      });
    }, refreshIn);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
