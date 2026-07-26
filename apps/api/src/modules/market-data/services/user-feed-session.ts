import { Logger } from '@nestjs/common';
import { generateTOTP } from '../utils/angel-one-totp';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import type { DecryptedBrokerCredentials } from '../../credential-vault/execution/credential-decryptor';
import type {
  FeedState,
  StateListener,
  TickListener,
  TokenRef,
  UserFeedSessionLike,
} from './user-feed.types';

/**
 * Angel One WebSocket feed mode. Mirrors `WsFeedMode` in
 * `angel-one-websocket.service.ts` — SNAP_QUOTE (3) includes OI. Redeclared
 * locally so this per-user session does not import (and instantiate the module
 * graph of) the shared singleton service.
 */
const enum WsFeedMode {
  SNAP_QUOTE = 3,
}

/**
 * Angel One WebSocket exchange-type codes. Mirrors `ExchangeType` in
 * `angel-one-websocket.service.ts:21-29`.
 */
const enum ExchangeType {
  NSE_CM = 1,
  BSE_CM = 3,
  MCX_FO = 5,
}

/** Reconnect settings (capped exponential backoff), mirroring the singleton. */
const MAX_RECONNECT_RETRIES = 5;
const INITIAL_RECONNECT_DELAY_MS = 1000;

/** Angel One WebSocket sends prices in paise. */
const PAISE_DIVISOR = 100;

/**
 * Constructor deps — all injectable so tests can supply fakes. The module
 * (Task 6) wires `withDecryptedCreds` to
 * `CredentialDecryptor.withDecryptedCredentials(userId, { reason: 'FEED' }, cb)`.
 */
export interface UserFeedSessionDeps {
  withDecryptedCreds: <T>(
    userId: string,
    cb: (creds: DecryptedBrokerCredentials) => Promise<T>,
  ) => Promise<T>;
  smartApiFactory: (apiKey: string) => { generateSession: Function; logout: Function };
  wsFactory: (opts: {
    jwttoken: string;
    clientcode: string;
    feedtype: string;
    apikey: string;
  }) => any;
}

/**
 * One Angel One `WebSocketV2` per user.
 *
 * This class owns its OWN socket built from the injected `wsFactory` — it does
 * NOT reuse the singleton `AngelOneWebSocketService` (which is bound to the
 * shared feed auth). Per-user tokens are obtained via a scoped vault lease:
 * inside `withDecryptedCreds`, we `generateTOTP(totpSecret)` + `generateSession`
 * and read the session's `jwtToken`/`feedToken`. Plaintext creds/tokens are
 * never logged and never persisted beyond what the socket needs.
 */
export class UserFeedSession implements UserFeedSessionLike {
  private readonly logger = new Logger(UserFeedSession.name);

  private ws: any = null;
  private smartApi: { generateSession: Function; logout: Function } | null = null;
  /** Client code — kept for logout() on dispose; not a secret credential. */
  private clientId: string | null = null;

  private connected = false;
  private disposed = false;
  private state: FeedState = 'connecting';

  /** Shared login/connect promise so concurrent ensureConnected() share ONE login. */
  private connectPromise: Promise<void> | null = null;

  /** Tokens the caller wants live, keyed by token string (for resubscribe). */
  private readonly activeTokens = new Map<string, TokenRef>();

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly tickListeners: TickListener[] = [];
  private readonly stateListeners: StateListener[] = [];

  constructor(
    private readonly userId: string,
    private readonly deps: UserFeedSessionDeps,
  ) {}

  // ──────────────────────────────────────────────
  // Public surface (UserFeedSessionLike)
  // ──────────────────────────────────────────────

  /**
   * Idempotent connect: concurrent calls share one login + one socket. Once
   * live, returns immediately.
   */
  async ensureConnected(): Promise<void> {
    if (this.disposed) throw new Error('UserFeedSession is disposed');
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().catch((err) => {
        // Allow a later ensureConnected() to retry a failed login.
        this.connectPromise = null;
        throw err;
      });
    }
    return this.connectPromise;
  }

  async subscribe(tokens: TokenRef[]): Promise<void> {
    if (this.disposed) throw new Error('UserFeedSession is disposed');
    await this.ensureConnected();

    const fresh = tokens.filter((t) => !this.activeTokens.has(t.token));
    if (fresh.length === 0) return;

    this.issueFetch(fresh, 1); // action 1 = subscribe
    for (const t of fresh) this.activeTokens.set(t.token, t);
  }

  async unsubscribe(tokens: TokenRef[]): Promise<void> {
    const existing = tokens.filter((t) => this.activeTokens.has(t.token));
    if (existing.length === 0) return;

    // Best-effort while connected; always drop from local tracking.
    if (this.connected && this.ws) {
      this.issueFetch(existing, 0); // action 0 = unsubscribe
    }
    for (const t of existing) this.activeTokens.delete(t.token);
  }

  activeTokenCount(): number {
    return this.activeTokens.size;
  }

  onTick(listener: TickListener): void {
    this.tickListeners.push(listener);
  }

  onState(listener: StateListener): void {
    this.stateListeners.push(listener);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearReconnectTimer();
    this.connectPromise = null;
    this.connected = false;

    this.closeSocket();

    // Best-effort logout of the per-user session.
    if (this.smartApi && this.clientId) {
      try {
        await this.smartApi.logout(this.clientId);
      } catch {
        // ignore — best-effort teardown
      }
    }
    this.smartApi = null;
    this.clientId = null;

    this.activeTokens.clear();
    this.setState('closed');
  }

  // ──────────────────────────────────────────────
  // Private — connect / login
  // ──────────────────────────────────────────────

  private async doConnect(): Promise<void> {
    this.setState('connecting');

    // Lease decrypted creds only for the duration of the login. We build the
    // SmartAPI client + WebSocket INSIDE the lease so the api key never lives
    // beyond it; only jwtToken/feedToken (+ non-secret clientId) survive.
    await this.deps.withDecryptedCreds(this.userId, async (creds) => {
      this.smartApi = this.deps.smartApiFactory(creds.apiKey);
      const totp = generateTOTP(creds.totpSecret);
      const session = await this.smartApi.generateSession(creds.clientId, creds.password, totp);

      const jwtToken: string | undefined = session?.data?.jwtToken;
      const feedToken: string | undefined = session?.data?.feedToken;
      if (!jwtToken || !feedToken) {
        throw new Error('Angel One session missing jwtToken/feedToken');
      }

      this.clientId = creds.clientId;
      await this.openSocket({
        jwttoken: jwtToken,
        clientcode: creds.clientId,
        feedtype: feedToken,
        apikey: creds.apiKey,
      });
    });

    this.connected = true;
    this.reconnectAttempts = 0;
    this.setState('live');

    // Restore any subscriptions that survived a reconnect.
    if (this.activeTokens.size > 0) {
      this.issueFetch(Array.from(this.activeTokens.values()), 1);
    }
  }

  private async openSocket(opts: {
    jwttoken: string;
    clientcode: string;
    feedtype: string;
    apikey: string;
  }): Promise<void> {
    // Tear down any prior socket FIRST. On the reconnect path a stale `this.ws`
    // keeps an internal heartbeat timer alive, firing ws.send() on a dead
    // socket and throwing "WebSocket is not open" forever (the crash class).
    this.closeSocket();

    this.ws = this.deps.wsFactory(opts);
    this.registerEventHandlers();
    await this.ws.connect();
  }

  private closeSocket(): void {
    if (this.ws) {
      try {
        this.ws.close?.();
      } catch {
        // ignore — best-effort teardown
      }
      this.ws = null;
    }
  }

  // ──────────────────────────────────────────────
  // Private — subscribe payload (mirror AngelOneWebSocketService.subscribe)
  // ──────────────────────────────────────────────

  /**
   * Build and send the SNAP_QUOTE fetchData payload, grouped by exchange since a
   * TokenRef carries its own exchange. Shape mirrors
   * `AngelOneWebSocketService.subscribe` (`:210-217`): flat
   * `{ correlationID, action, mode, exchangeType, tokens }`.
   */
  private issueFetch(tokens: TokenRef[], action: 0 | 1): void {
    if (!this.ws) return;

    const byExchange = new Map<ExchangeType, string[]>();
    for (const t of tokens) {
      const ex = this.mapExchange(t.exchange);
      const arr = byExchange.get(ex);
      if (arr) arr.push(t.token);
      else byExchange.set(ex, [t.token]);
    }

    const prefix = action === 1 ? 'sub' : 'unsub';
    for (const [exchangeType, toks] of byExchange) {
      this.ws.fetchData({
        correlationID: `${prefix}_${Date.now()}`,
        action,
        mode: WsFeedMode.SNAP_QUOTE,
        exchangeType,
        tokens: toks,
      });
    }
  }

  private mapExchange(exchange: string): ExchangeType {
    switch (exchange.toUpperCase()) {
      case 'NSE':
        return ExchangeType.NSE_CM; // 1
      case 'BSE':
        return ExchangeType.BSE_CM; // 3
      case 'MCX':
        return ExchangeType.MCX_FO; // 5
      default:
        return ExchangeType.NSE_CM;
    }
  }

  // ──────────────────────────────────────────────
  // Private — event handlers / tick normalization
  // ──────────────────────────────────────────────

  private registerEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('tick', (data: any) => {
      try {
        const tick = this.parseTickData(data);
        if (tick) {
          for (const l of this.tickListeners) l(tick);
        }
      } catch (error) {
        this.logger.warn(
          `Failed to parse tick: ${error instanceof Error ? error.message : error}`,
        );
      }
    });

    this.ws.on('close', () => {
      this.onSocketDown('reconnecting');
    });

    this.ws.on('error', (error: any) => {
      this.logger.error(
        `WebSocket error: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      this.onSocketDown('reconnecting');
    });
  }

  private onSocketDown(nextState: FeedState): void {
    this.connected = false;
    this.connectPromise = null;
    if (this.disposed) return;
    this.setState(nextState);
    this.scheduleReconnect();
  }

  /** Parse raw tick data into our TickData shape (mirrors mapSingleTick, `:329-354`). */
  private parseTickData(raw: any): TickData | null {
    if (!raw) return null;
    if (Array.isArray(raw)) {
      return raw.length > 0 ? this.mapSingleTick(raw[0]) : null;
    }
    return this.mapSingleTick(raw);
  }

  private mapSingleTick(tick: any): TickData | null {
    if (!tick) return null;

    // Token can arrive with extra quotes: "\"99926013\"" → strip them.
    const rawToken = String(tick.token ?? tick.symbolToken ?? tick.tk ?? '');
    const token = rawToken.replace(/"/g, '');

    return {
      token,
      symbol: String(tick.symbol ?? tick.tradingSymbol ?? tick.name ?? ''),
      ltp: this.toNumber(tick.last_traded_price ?? tick.ltp ?? tick.lp ?? 0) / PAISE_DIVISOR,
      open:
        this.toNumber(
          tick.open_price_day ?? tick.open_price_of_the_day ?? tick.open ?? tick.op ?? 0,
        ) / PAISE_DIVISOR,
      high:
        this.toNumber(
          tick.high_price_day ?? tick.high_price_of_the_day ?? tick.high ?? tick.hp ?? 0,
        ) / PAISE_DIVISOR,
      low:
        this.toNumber(
          tick.low_price_day ?? tick.low_price_of_the_day ?? tick.low ?? tick.lop ?? 0,
        ) / PAISE_DIVISOR,
      close:
        this.toNumber(tick.close_price ?? tick.closed_price ?? tick.close ?? tick.cp ?? 0) /
        PAISE_DIVISOR,
      volume: this.toNumber(
        tick.vol_traded ?? tick.volume_trade_for_the_day ?? tick.volume ?? tick.v ?? 0,
      ),
      oi: tick.open_interest ? this.toNumber(tick.open_interest) : undefined,
      timestamp: tick.exchange_timestamp
        ? new Date(Number(tick.exchange_timestamp))
        : new Date(),
    };
  }

  private toNumber(val: any): number {
    const num = Number(val);
    return isNaN(num) ? 0 : num;
  }

  // ──────────────────────────────────────────────
  // Private — reconnect / state
  // ──────────────────────────────────────────────

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    if (this.disposed) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_RETRIES) {
      this.logger.error(
        `User feed reconnect failed after ${MAX_RECONNECT_RETRIES} attempts for user ${this.userId}`,
      );
      this.setState('error');
      return;
    }

    const delay = INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      // Full re-login: re-lease creds, rebuild socket, resubscribe activeTokens.
      this.doConnect().catch((error) => {
        this.logger.warn(
          `Reconnect attempt ${this.reconnectAttempts} failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(next: FeedState): void {
    this.state = next;
    for (const l of this.stateListeners) {
      try {
        l(next);
      } catch {
        // a listener throwing must not break the feed
      }
    }
  }
}
