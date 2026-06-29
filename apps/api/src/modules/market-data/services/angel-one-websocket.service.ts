import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';
import { AngelOneAuthService } from './angel-one-auth.service';
import { TickData } from '../../../common/interfaces/broker-adapter.interface';

/**
 * WebSocket feed modes supported by Angel One.
 *   1 = LTP
 *   2 = QUOTE
 *   3 = SNAP_QUOTE (includes OI)
 */
export enum WsFeedMode {
  LTP = 1,
  QUOTE = 2,
  SNAP_QUOTE = 3,
}

/**
 * Exchange type codes used by Angel One WebSocket.
 */
export enum ExchangeType {
  NSE_CM = 1,
  NSE_FO = 2,
  BSE_CM = 3,
  BSE_FO = 4,
  MCX_FO = 5,
  NCX_FO = 7,
  CDE_FO = 13,
}

/** Maximum tokens per WebSocket connection */
const MAX_SUBSCRIPTIONS = 50;

/** Reconnect settings */
const MAX_RECONNECT_RETRIES = 5;
const INITIAL_RECONNECT_DELAY_MS = 1000;

@Injectable()
export class AngelOneWebSocketService extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(AngelOneWebSocketService.name);

  private ws: any = null;
  private connected = false;
  private activeTokens: Set<string> = new Set();
  private currentMode: WsFeedMode = WsFeedMode.SNAP_QUOTE;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  constructor(private readonly authService: AngelOneAuthService) {
    super();
    this.setMaxListeners(100);
  }

  onModuleDestroy(): void {
    this.intentionalDisconnect = true;
    this.disconnect().catch(() => {});
  }

  /**
   * Establish WebSocket connection to Angel One.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      this.logger.log('WebSocket already connected');
      return;
    }

    try {
      // Guard: ensure auth service is ready before attempting WebSocket connection
      if (!this.authService.isAuthenticated()) {
        throw new Error(
          'Cannot connect WebSocket: auth service is not authenticated. ' +
            'Ensure login() completes before calling connect().',
        );
      }

      // Dynamic import — the smartapi-javascript package exports WebSocketV2
      // @ts-ignore — smartapi-javascript has no type declarations
      const { WebSocketV2 } = await import('smartapi-javascript');

      const jwtToken = this.authService.getAuthToken();
      const feedToken = this.authService.getFeedToken();
      const clientId = this.authService.getClientId();
      const apiKey = this.authService.getApiKey();

      // Diagnostic logging — show whether each credential is present (never log actual values)
      this.logger.log(
        `WebSocket auth check — jwtToken: ${jwtToken ? 'SET' : 'MISSING'}, ` +
          `feedToken: ${feedToken ? 'SET' : 'MISSING'}, ` +
          `clientId: ${clientId ? 'SET' : 'MISSING'}, ` +
          `apiKey: ${apiKey ? 'SET' : 'MISSING'}`,
      );

      if (!jwtToken || !feedToken || !clientId || !apiKey) {
        throw new Error(
          'One or more auth tokens are undefined. ' +
            `Missing: ${[
              !jwtToken && 'jwtToken',
              !feedToken && 'feedToken',
              !clientId && 'clientId',
              !apiKey && 'apiKey',
            ]
              .filter(Boolean)
              .join(', ')}`,
        );
      }

      // Tear down any prior socket FIRST. On the reconnect path connect() runs
      // with a stale `this.ws` still set; replacing it without closing leaves the
      // old instance's internal heartbeat timer alive, firing ws.send() on a dead
      // socket and throwing "WebSocket is not open" forever (the crash class).
      if (this.ws) {
        try {
          this.ws.close?.();
        } catch {
          // ignore — best-effort teardown
        }
        this.ws = null;
      }

      this.ws = new WebSocketV2({
        jwttoken: jwtToken,
        clientcode: clientId,
        feedtype: feedToken,
        apikey: apiKey,
      });

      this.logger.log('WebSocketV2 instance created, initiating connection...');
      await this.ws.connect();
      this.connected = true;
      this.reconnectAttempts = 0;
      this.intentionalDisconnect = false;

      this.registerEventHandlers();
      this.logger.log('WebSocket connected to Angel One');

      // Re-subscribe tokens that were active before a reconnect
      if (this.activeTokens.size > 0) {
        await this.resubscribeActive();
      }
    } catch (error) {
      this.connected = false;
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`WebSocket connection failed: ${msg}`);
      this.scheduleReconnect();
      throw error;
    }
  }

  /**
   * Gracefully disconnect the WebSocket.
   */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();

    if (this.ws) {
      try {
        this.ws.close?.();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.connected = false;
    this.logger.log('WebSocket disconnected');
  }

  /**
   * Check whether the WebSocket is currently connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Subscribe to live tick data for the given tokens.
   * Enforces the 50-token limit.
   *
   * @param tokens - Array of instrument token strings
   * @param mode - Feed mode (default: SNAP_QUOTE)
   * @param exchangeType - Exchange type code (default: NSE_CM)
   */
  async subscribe(
    tokens: string[],
    mode: WsFeedMode = WsFeedMode.SNAP_QUOTE,
    exchangeType: ExchangeType = ExchangeType.NSE_CM,
  ): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error('WebSocket is not connected. Call connect() first.');
    }

    const newTokens = tokens.filter((t) => !this.activeTokens.has(t));
    if (newTokens.length === 0) {
      this.logger.log('All requested tokens are already subscribed');
      return;
    }

    if (this.activeTokens.size + newTokens.length > MAX_SUBSCRIPTIONS) {
      throw new Error(
        `Cannot subscribe: would exceed max ${MAX_SUBSCRIPTIONS} tokens. ` +
          `Currently active: ${this.activeTokens.size}, requested: ${newTokens.length}`,
      );
    }

    this.currentMode = mode;

    const correlationId = `sub_${Date.now()}`;
    this.ws.fetchData({
      correlationID: correlationId,
      action: 1, // subscribe
      mode,
      exchangeType,
      tokens: newTokens,
    });

    for (const token of newTokens) {
      this.activeTokens.add(token);
    }

    this.logger.log(
      `Subscribed to ${newTokens.length} tokens (total active: ${this.activeTokens.size})`,
    );
  }

  /**
   * Unsubscribe from live tick data for the given tokens.
   */
  async unsubscribe(
    tokens: string[],
    exchangeType: ExchangeType = ExchangeType.NSE_CM,
  ): Promise<void> {
    if (!this.connected || !this.ws) {
      // Just remove from local tracking
      for (const token of tokens) {
        this.activeTokens.delete(token);
      }
      return;
    }

    const existingTokens = tokens.filter((t) => this.activeTokens.has(t));
    if (existingTokens.length === 0) return;

    const correlationId = `unsub_${Date.now()}`;
    this.ws.fetchData({
      correlationID: correlationId,
      action: 0, // unsubscribe
      mode: this.currentMode,
      exchangeType,
      tokens: existingTokens,
    });

    for (const token of existingTokens) {
      this.activeTokens.delete(token);
    }

    this.logger.log(
      `Unsubscribed from ${existingTokens.length} tokens (total active: ${this.activeTokens.size})`,
    );
  }

  /**
   * Get the set of currently subscribed tokens.
   */
  getActiveSubscriptions(): string[] {
    return Array.from(this.activeTokens);
  }

  // ──────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────

  private registerEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('tick', (data: any) => {
      try {
        this.logger.debug(`WS tick: ${JSON.stringify(data).substring(0, 300)}`);
        const tick = this.parseTickData(data);
        if (tick) {
          this.emit('tick', tick);
        } else {
          this.logger.debug('parseTickData returned null');
        }
      } catch (error) {
        this.logger.warn(
          `Failed to parse tick: ${error instanceof Error ? error.message : error}`,
        );
      }
    });

    this.ws.on('close', () => {
      this.logger.warn('WebSocket connection closed');
      this.connected = false;
      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error: any) => {
      this.logger.error(
        `WebSocket error: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      this.connected = false;
      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });
  }

  /**
   * Parse raw tick data from Angel One WebSocket into our TickData format.
   */
  private parseTickData(raw: any): TickData | null {
    if (!raw) return null;

    // Angel One WebSocket can return data in various formats depending on mode.
    // Handle both parsed JSON objects and arrays.
    if (Array.isArray(raw)) {
      // Binary-parsed array format: each element is an instrument update
      return raw.length > 0 ? this.mapSingleTick(raw[0]) : null;
    }

    return this.mapSingleTick(raw);
  }

  private mapSingleTick(tick: any): TickData | null {
    if (!tick) return null;

    // Angel One WebSocket returns:
    // - token with extra quotes: "\"99926013\"" → strip them
    // - prices in paise (multiply by 100): 6195760 → 61957.60
    const rawToken = String(tick.token ?? tick.symbolToken ?? tick.tk ?? '');
    const token = rawToken.replace(/"/g, ''); // Remove any extra quotes

    const divisor = 100; // Angel One WebSocket sends prices in paise

    return {
      token,
      symbol: String(tick.symbol ?? tick.tradingSymbol ?? tick.name ?? ''),
      ltp: this.toNumber(tick.last_traded_price ?? tick.ltp ?? tick.lp ?? 0) / divisor,
      open: this.toNumber(tick.open_price_day ?? tick.open_price_of_the_day ?? tick.open ?? tick.op ?? 0) / divisor,
      high: this.toNumber(tick.high_price_day ?? tick.high_price_of_the_day ?? tick.high ?? tick.hp ?? 0) / divisor,
      low: this.toNumber(tick.low_price_day ?? tick.low_price_of_the_day ?? tick.low ?? tick.lop ?? 0) / divisor,
      close: this.toNumber(tick.close_price ?? tick.closed_price ?? tick.close ?? tick.cp ?? 0) / divisor,
      volume: this.toNumber(tick.vol_traded ?? tick.volume_trade_for_the_day ?? tick.volume ?? tick.v ?? 0),
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

  /**
   * Re-subscribe to all active tokens after a reconnect.
   */
  private async resubscribeActive(): Promise<void> {
    if (this.activeTokens.size === 0) return;

    const tokens = Array.from(this.activeTokens);
    // Clear so subscribe() treats them as new
    this.activeTokens.clear();

    this.logger.log(`Re-subscribing to ${tokens.length} tokens after reconnect`);
    await this.subscribe(tokens, this.currentMode);
  }

  /**
   * Schedule a reconnection with exponential backoff.
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    if (this.reconnectAttempts >= MAX_RECONNECT_RETRIES) {
      this.logger.error(
        `WebSocket reconnection failed after ${MAX_RECONNECT_RETRIES} attempts. ` +
          'Manual intervention required.',
      );
      this.emit('reconnect_failed');
      return;
    }

    const delay = INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.logger.log(
      `Scheduling WebSocket reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_RETRIES} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        // Refresh auth if needed before reconnecting
        if (!this.authService.isAuthenticated()) {
          await this.authService.refreshToken();
        }
        await this.connect();
      } catch (error) {
        this.logger.error(
          `Reconnect attempt ${this.reconnectAttempts} failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
