import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// @ts-ignore — smartapi-javascript has no type declarations
import { SmartAPI } from 'smartapi-javascript';
// RFC-6238 TOTP extracted to a shared util (TDA-005) so the live login here and
// the per-user AngelOneValidator produce codes identically.
import { generateTOTP } from '../utils/angel-one-totp';

@Injectable()
export class AngelOneAuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AngelOneAuthService.name);

  private smartApi: any;
  private jwtToken: string | null = null;
  private refreshTokenValue: string | null = null;
  private feedToken: string | null = null;
  private tokenExpiresAt: Date | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private authenticated = false;

  // Mutable so updateCredentials() can swap in DB-stored credentials at runtime
  // (the broker settings flow); seeded from env in the constructor.
  private apiKey: string;
  private clientId: string;
  private password: string;
  private totpSecret: string;

  private static readonly MAX_LOGIN_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 2000;
  /** Refresh 1 hour before expiry (tokens last ~24hrs) */
  private static readonly TOKEN_REFRESH_BUFFER_MS = 60 * 60 * 1000;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.getOrThrow<string>('ANGEL_ONE_API_KEY');
    this.clientId = this.configService.getOrThrow<string>('ANGEL_ONE_CLIENT_ID');
    this.password = this.configService.getOrThrow<string>('ANGEL_ONE_PASSWORD');
    this.totpSecret = this.configService.getOrThrow<string>('ANGEL_ONE_TOTP_SECRET');

    this.smartApi = new SmartAPI({ api_key: this.apiKey });
  }

  async onModuleInit(): Promise<void> {
    // Skip auto-login if placeholder credentials are still in .env
    if (this.apiKey === 'your_api_key_here' || this.clientId === 'your_client_id_here') {
      this.logger.warn('Angel One credentials not configured — skipping auto-login');
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
   * Retries up to 3 times on failure.
   */
  async login(): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= AngelOneAuthService.MAX_LOGIN_RETRIES; attempt++) {
      try {
        this.logger.log(`Login attempt ${attempt}/${AngelOneAuthService.MAX_LOGIN_RETRIES}`);

        const totp = generateTOTP(this.totpSecret);
        const session = await this.smartApi.generateSession(
          this.clientId,
          this.password,
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
   * Swap in new credentials at runtime (broker settings flow). Recreates the
   * SmartAPI client with the new API key and clears the current session so the
   * next login() uses the new values. Does NOT auto-login — the caller decides.
   */
  updateCredentials(
    apiKey: string,
    clientId: string,
    password: string,
    totpSecret: string,
  ): void {
    this.apiKey = apiKey;
    this.clientId = clientId;
    this.password = password;
    this.totpSecret = totpSecret;
    this.smartApi = new SmartAPI({ api_key: apiKey });
    this.clearSession();
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
      await this.smartApi.logout(this.clientId);
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
