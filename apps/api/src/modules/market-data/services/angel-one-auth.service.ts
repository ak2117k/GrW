import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// @ts-ignore — smartapi-javascript has no type declarations
import { SmartAPI } from 'smartapi-javascript';
// RFC-6238 TOTP extracted to a shared util (TDA-005) so the live login here and
// the per-user AngelOneValidator produce codes identically.
import { generateTOTP } from '../utils/angel-one-totp';
import { FeedCredentialProvider } from './feed-credential-provider';

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

  // The feed account's NON-secret identifiers, set at login() from the leased
  // credentials. The raw password / TOTP secret are NEVER stored on the instance —
  // they live only inside the FeedCredentialProvider lease and are zeroized on
  // exit. Only the ~24h session (jwt/feed token + the authenticated SmartAPI
  // client, which holds the JWT internally) is held warm.
  private apiKey = '';
  private clientId = '';

  private static readonly MAX_LOGIN_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 2000;
  /** Refresh 1 hour before expiry (tokens last ~24hrs) */
  private static readonly TOKEN_REFRESH_BUFFER_MS = 60 * 60 * 1000;

  // Credential resolution (env-first, vault fallback) is delegated to the
  // FeedCredentialProvider; this service only owns the session lifecycle.
  constructor(private readonly feedCredentials: FeedCredentialProvider) {}

  async onModuleInit(): Promise<void> {
    // Only attempt auto-login when a feed account is resolvable (env creds set,
    // or a designated vault account with connected credentials). Otherwise skip
    // gracefully — the feed serves demo/REST data until one is configured.
    if (!(await this.feedCredentials.hasFeedCredentials())) {
      this.logger.warn(
        'No market-data feed credentials configured (env or designated vault ' +
        'account) — skipping auto-login. Live market data unavailable until a ' +
        'feed account is set.',
      );
      return;
    }

    try {
      await this.login();
      this.logger.log('Auto-login succeeded');
    } catch (error) {
      this.logger.error(
        `Auto-login failed: ${error instanceof Error ? error.message : error}. ` +
        'Live market data will be unavailable until login succeeds.',
      );
    }
  }

  onModuleDestroy(): void {
    this.clearRefreshTimer();
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

          const totp = generateTOTP(creds.totpSecret);
          const session = await this.smartApi.generateSession(
            creds.clientId,
            creds.password,
            totp,
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
   */
  getSmartApi(): any {
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
