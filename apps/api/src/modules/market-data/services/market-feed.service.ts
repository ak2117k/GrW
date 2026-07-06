import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  TickData,
  FeedCallback,
  BrokerAdapter,
} from '../../../common/interfaces/broker-adapter.interface';
import { AngelOneAuthService } from './angel-one-auth.service';
import { Quote, Exchange } from '@td/shared/types';
import {
  MARKET_OPEN_HOUR,
  MARKET_OPEN_MINUTE,
  MARKET_CLOSE_HOUR,
  MARKET_CLOSE_MINUTE,
  MCX_OPEN_HOUR,
  MCX_OPEN_MINUTE,
  MCX_CLOSE_HOUR,
  MCX_CLOSE_MINUTE,
  ANGEL_ONE_WEBSOCKET_MAX_TOKENS,
  INDICES,
  SECTOR_INDICES,
  MAJOR_STOCKS,
  COMMODITIES,
} from '@td/shared/constants';
import { CandleAggregatorService } from './candle-aggregator.service';
import { InstrumentService } from './instrument.service';
import { MarketDataGateway, CandlePayload } from '../gateways/market-data.gateway';
import { LevelBookService } from '../../signal-generator/services/level-book.service';

/** Redis pub/sub channel for tick distribution across services. */
const REDIS_TICKS_CHANNEL = 'market:ticks';

/**
 * Injection token for the broker adapter.
 * The AngelOneAdapterService (built by another agent) should be provided
 * under this token. If unavailable, MarketFeedService degrades gracefully.
 */
export const BROKER_ADAPTER_TOKEN = 'BROKER_ADAPTER';

/**
 * Subscription slot allocation:
 *   Slots  1-30: Primary watchlist (user-selected tokens)
 *   Slots 31-50: Scan rotation (strategy scanner tokens)
 */
const PRIMARY_SLOT_MAX = 30;
const TOTAL_SLOT_MAX = ANGEL_ONE_WEBSOCKET_MAX_TOKENS; // 50

@Injectable()
export class MarketFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketFeedService.name);

  /**
   * In-memory latest quote cache — fast access for REST and gateway.
   *
   * CROSS-SEGMENT COLLISION FIX: Angel One reuses the same numeric token
   * across segments (e.g. 7866 = NSE GVPIL equity AND a CDS USDINR currency
   * contract). Keying by token ALONE let one segment's tick clobber the
   * other's quote → phantom prices served to every getQuote() caller. The
   * cache is therefore keyed by a COMPOSITE `${exchange}:${token}` (see
   * `quoteKey`). The public `getQuote(token)` remains token-only for
   * backward compatibility and resolves equity-venue semantics.
   */
  private readonly quoteCache = new Map<string, Quote>();

  /** Tokens currently subscribed as primary watchlist. */
  private readonly primaryTokens = new Set<string>();

  /** Tokens currently subscribed for scan rotation. */
  private readonly scanTokens = new Set<string>();

  /**
   * Ad-hoc "viewing" subscriptions — tokens the user is currently
   * looking at on a chart but that aren't in the universe-scanner or
   * primary watchlist. LRU eviction at MAX_VIEWING_TOKENS so opening
   * many charts doesn't run away with the broker's 50-token slot
   * budget. Map preserves insertion order; on access we delete-then-set
   * to bump to the head (most-recent). The value is the exchange,
   * which we need at unsubscribe time.
   */
  private readonly viewingTokens = new Map<string, string>();
  private readonly MAX_VIEWING_TOKENS = 10;

  /**
   * Watch monitor subscriptions (Stage 2 Chartink lifecycle).
   * Keyed by token → set of watchEntryIds that care about that token.
   * Reverse map for fast unsubscribe by entry id.
   */
  private readonly watchTokens = new Map<string, Set<string>>();
  private readonly watchEntryTokens = new Map<string, Set<string>>();
  // Multi-handler support: each module can register its own tick callback.
  // The gated WatchMonitorModule registers WatchService.onTick. The ungated
  // shadow-track registers UngatedWatchService.onTick. Both fire on every
  // tick for any watched token.
  private watchTickHandlers: Array<(token: string, ltp: number, ts: Date) => void | Promise<void>> = [];

  /** Whether the feed is actively running. */
  private feedActive = false;

  /** Current feed mode: 'websocket', 'rest-polling', or 'none'. */
  private feedMode: 'websocket' | 'rest-polling' | 'none' = 'none';

  /** Interval handle for REST-based polling fallback. */
  private restPollingInterval: ReturnType<typeof setInterval> | null = null;

  /** Interval handle for periodic WebSocket reconnect attempts while REST-polling. */
  private wsReconnectInterval: ReturnType<typeof setInterval> | null = null;

  /** REST polling interval in milliseconds. */
  private readonly REST_POLL_INTERVAL_MS = 5_000;

  /** How often to retry WebSocket connection while REST-polling (ms). */
  private readonly WS_RECONNECT_RETRY_MS = 60_000;

  /** Redis publisher for cross-service tick distribution. */
  private redisPub: Redis | null = null;

  /** Redis subscriber for receiving ticks from other processes. */
  private redisSub: Redis | null = null;

  /** Handle returned by the broker adapter callback registration. */
  private feedCallback: FeedCallback | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly candleAggregator: CandleAggregatorService,
    private readonly instrumentService: InstrumentService,
    private readonly gateway: MarketDataGateway,
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null,
    private readonly angelOneAuth: AngelOneAuthService,
    @Optional()
    @Inject(forwardRef(() => LevelBookService))
    private readonly levelBookService: LevelBookService | null,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initRedis();

    // Register candle close listener so we can push to the gateway
    this.candleAggregator.onCandleClose((candle) => {
      const payload: CandlePayload = {
        token: candle.token,
        timeframe: candle.timeframe,
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
      this.gateway.emitCandle(payload);
    });

    this.logger.log('MarketFeedService initialized');

    // Auto-start: wait for auth service to finish initialising, then seed
    // quotes and optionally start the WebSocket feed.
    this.autoStart();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopRestPolling();
    this.stopWsReconnectTimer();
    await this.stopFeed();
    await this.redisPub?.quit();
    await this.redisSub?.quit();
  }

  // ------------------------------------------------------------------
  //  Public API
  // ------------------------------------------------------------------

  /**
   * Start the live market data feed.
   * Subscribes to major indices by default.
   */
  async startFeed(): Promise<void> {
    if (this.feedActive) {
      this.logger.warn('Feed is already active');
      return;
    }

    if (!this.brokerAdapter) {
      this.logger.warn(
        'No broker adapter available — feed will not connect to live market. ' +
          'Serving cached data only.',
      );
      this.feedActive = true;
      this.feedMode = 'none';
      this.broadcastStatus();
      return;
    }

    try {
      this.feedCallback = (tick: TickData) => this.handleTick(tick);

      // Sync the COMMODITIES constants to whatever the DB currently says
      // (the roll script and the runtime resolveCommodityTokens both keep
      // the DB current). This matters because the broker adapter routes
      // tokens to the right exchange WS by checking membership in
      // Object.values(COMMODITIES) — if a rolled token isn't in there,
      // it gets misrouted to NSE_CM and Angel One drops it silently.
      const dbCommodities = this.instrumentService.getCommodityInstruments();
      for (const inst of dbCommodities) {
        const constEntry = (COMMODITIES as Record<string, { symbol: string; token: string }>)[inst.symbol];
        if (constEntry && constEntry.token !== inst.token) {
          this.logger.log(
            `Syncing COMMODITIES.${inst.symbol} token ${constEntry.token} → ${inst.token} (from DB)`,
          );
          constEntry.token = inst.token;
        }
      }

      const allDefaultTokens = [
        ...(Object.values(INDICES) as Array<{ token: string }>).map((idx) => idx.token),
        ...(Object.values(SECTOR_INDICES) as Array<{ token: string }>).map((s) => s.token),
        ...(Object.values(MAJOR_STOCKS) as Array<{ token: string }>).map((s) => s.token),
        ...(Object.values(COMMODITIES) as Array<{ token: string }>).map((c) => c.token),
        // Also include any commodity tokens that exist in DB but not in
        // the constants file (e.g. future additions before constant updates)
        ...dbCommodities.map((c) => c.token),
      ];
      // Deduplicate and filter out unresolved placeholder tokens ('0')
      const uniqueTokens = [...new Set(allDefaultTokens)].filter((t) => t !== '0');
      await this.subscribe(uniqueTokens);

      this.feedActive = true;
      this.feedMode = 'websocket';
      this.broadcastStatus();
      this.logger.log('Market data feed started (WebSocket mode)');
    } catch (error) {
      this.logger.error(
        `Failed to start feed: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  /**
   * Stop the live feed and flush all in-progress candles to the database.
   */
  async stopFeed(): Promise<void> {
    if (!this.feedActive) return;

    try {
      if (this.brokerAdapter) {
        const allTokens = [
          ...Array.from(this.primaryTokens),
          ...Array.from(this.scanTokens),
        ];
        if (allTokens.length > 0) {
          this.brokerAdapter.unsubscribeFromFeed(allTokens);
        }
      }

      await this.candleAggregator.flushAll();

      this.stopRestPolling();
      this.stopWsReconnectTimer();
      this.primaryTokens.clear();
      this.scanTokens.clear();
      this.feedActive = false;
      this.feedMode = 'none';
      this.broadcastStatus();
      this.logger.log('Market data feed stopped');
    } catch (error) {
      this.logger.error(
        `Error stopping feed: ${error instanceof Error ? error.message : error}`,
      );
      this.feedActive = false;
      this.feedMode = 'none';
    }
  }

  /**
   * Subscribe tokens to the live feed in the primary watchlist slots.
   */
  async subscribe(tokens: string[]): Promise<string[]> {
    const toSubscribe: string[] = [];

    for (const token of tokens) {
      if (this.primaryTokens.has(token) || this.scanTokens.has(token)) {
        continue; // Already subscribed
      }
      if (this.primaryTokens.size >= PRIMARY_SLOT_MAX) {
        this.logger.warn(
          `Primary slot limit (${PRIMARY_SLOT_MAX}) reached — cannot subscribe ${token}`,
        );
        break;
      }
      this.primaryTokens.add(token);
      toSubscribe.push(token);
    }

    if (toSubscribe.length > 0) {
      await this.registerTokensWithBroker(toSubscribe);
      await this.ensureInstrumentMappings(toSubscribe);
    }

    return toSubscribe;
  }

  /**
   * Unsubscribe tokens from the live feed.
   */
  async unsubscribe(tokens: string[]): Promise<string[]> {
    const toUnsubscribe: string[] = [];

    for (const token of tokens) {
      if (this.primaryTokens.delete(token)) {
        toUnsubscribe.push(token);
      }
      if (this.scanTokens.delete(token)) {
        toUnsubscribe.push(token);
      }
    }

    if (toUnsubscribe.length > 0 && this.brokerAdapter) {
      try {
        this.brokerAdapter.unsubscribeFromFeed(toUnsubscribe);
      } catch (error) {
        this.logger.error(
          `Failed to unsubscribe tokens from broker: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return toUnsubscribe;
  }

  /**
   * Subscribe tokens in the scan rotation slots (31-50).
   * Used by the strategy scanner for temporary subscriptions.
   */
  async subscribeScan(tokens: string[]): Promise<string[]> {
    const maxScanSlots = TOTAL_SLOT_MAX - PRIMARY_SLOT_MAX;
    const toSubscribe: string[] = [];

    // Clear existing scan tokens to make room
    if (this.scanTokens.size + tokens.length > maxScanSlots) {
      const currentScan = Array.from(this.scanTokens);
      if (currentScan.length > 0 && this.brokerAdapter) {
        this.brokerAdapter.unsubscribeFromFeed(currentScan);
      }
      this.scanTokens.clear();
    }

    for (const token of tokens) {
      if (this.primaryTokens.has(token) || this.scanTokens.has(token)) {
        continue;
      }
      if (this.scanTokens.size >= maxScanSlots) break;
      this.scanTokens.add(token);
      toSubscribe.push(token);
    }

    if (toSubscribe.length > 0) {
      await this.registerTokensWithBroker(toSubscribe);
      await this.ensureInstrumentMappings(toSubscribe);
    }

    return toSubscribe;
  }

  /**
   * Ad-hoc viewing subscription. Called when the user opens a chart for
   * a token that isn't in the universe-scanner or primary watchlist —
   * any arbitrary stock from search. Routes the token to the right WS
   * exchange via brokerAdapter.subscribeAdHoc, then tracks it in an
   * LRU pool capped at MAX_VIEWING_TOKENS. When the pool is full, the
   * oldest viewing token is evicted (unsubscribed) to make room.
   *
   * Idempotent: if the token is already subscribed via any path
   * (primary, scan, or viewing) this is a no-op except for moving the
   * viewing entry to the LRU head.
   */
  async addViewing(token: string, exchange: string): Promise<void> {
    if (!token || token === '0') return;
    if (this.primaryTokens.has(token) || this.scanTokens.has(token)) {
      return; // already covered by the scanner / watchlist paths
    }
    // Already viewing — bump to head of LRU.
    if (this.viewingTokens.has(token)) {
      this.viewingTokens.delete(token);
      this.viewingTokens.set(token, exchange);
      return;
    }
    // Make room if at capacity. Evict the oldest entry (Map iteration
    // order = insertion order, so first key is the LRU tail).
    if (this.viewingTokens.size >= this.MAX_VIEWING_TOKENS) {
      const oldest = this.viewingTokens.keys().next().value as string | undefined;
      if (oldest) {
        this.viewingTokens.delete(oldest);
        this.brokerAdapter?.unsubscribeFromFeed?.([oldest]);
        this.logger.log(`Evicted viewing token ${oldest} (LRU)`);
      }
    }
    this.viewingTokens.set(token, exchange);
    if (this.brokerAdapter?.subscribeAdHoc) {
      await this.brokerAdapter.subscribeAdHoc(token, exchange);
      this.logger.log(`Viewing-subscribed ${token} on ${exchange} (pool ${this.viewingTokens.size}/${this.MAX_VIEWING_TOKENS})`);
    }
    await this.ensureInstrumentMappings([token]);
  }

  /**
   * Build the composite cache key for a quote: `${exchange}:${token}`.
   * Exchange is canonicalised so the key is stable regardless of caller
   * spelling (NSE vs NSE_CM, etc.).
   */
  private quoteKey(exchange: string | undefined | null, token: string): string {
    return `${this.normalizeExchange(exchange)}:${token}`;
  }

  /**
   * Canonicalise an exchange string for use in the composite cache key.
   * The cash-equity / index segment of each venue collapses to the bare
   * venue name, matching how callers pass `exchange` ('NSE', 'BSE', 'MCX').
   */
  private normalizeExchange(exchange: string | undefined | null): string {
    const e = String(exchange ?? 'NSE').toUpperCase();
    switch (e) {
      case 'NSE_CM':
        return 'NSE';
      case 'BSE_CM':
        return 'BSE';
      case 'MCX_FO':
        return 'MCX';
      case 'NSE_FO':
        return 'NFO';
      default:
        return e;
    }
  }

  /**
   * Segments a token-only `getQuote(token)` is allowed to resolve to, in
   * preference order. Equity venues (NSE, BSE) come first — token-only
   * lookups historically carried equity/index semantics. MCX (commodities)
   * is an acceptable last resort for a token that ONLY streams there.
   *
   * Currency (CDS) and derivatives (NFO/NCDEX) are deliberately EXCLUDED:
   * those are exactly the segments that collide with equity tokens (e.g.
   * the 7866 NSE-vs-CDS case), so a token-only request must never be
   * satisfied by a currency/derivatives quote. Such a quote can only be
   * fetched by an explicit-exchange path.
   */
  private static readonly TOKEN_ONLY_SEGMENTS = ['NSE', 'BSE', 'MCX'] as const;

  /**
   * Get the latest cached quote for a token (token-only — equity-venue
   * semantics). Tries NSE, then BSE, then MCX. Never returns a quote
   * recorded under a colliding currency/derivatives segment.
   */
  getQuote(token: string): Quote | null {
    for (const seg of MarketFeedService.TOKEN_ONLY_SEGMENTS) {
      const q = this.quoteCache.get(`${seg}:${token}`);
      if (q) return q;
    }
    return null;
  }

  /**
   * Get all cached quotes.
   */
  getAllQuotes(): Quote[] {
    return Array.from(this.quoteCache.values());
  }

  /**
   * Get feed status information.
   */
  getStatus(): {
    feedActive: boolean;
    feedMode: string;
    primarySubscriptions: number;
    scanSubscriptions: number;
    totalSubscriptions: number;
    cachedQuotes: number;
    connectedClients: number;
    brokerAdapterAvailable: boolean;
  } {
    return {
      feedActive: this.feedActive,
      feedMode: this.feedMode,
      primarySubscriptions: this.primaryTokens.size,
      scanSubscriptions: this.scanTokens.size,
      totalSubscriptions: this.primaryTokens.size + this.scanTokens.size,
      cachedQuotes: this.quoteCache.size,
      connectedClients: this.gateway.getConnectedClientCount(),
      brokerAdapterAvailable: this.brokerAdapter !== null,
    };
  }

  /**
   * Calculate market breadth from cached quotes.
   * Counts how many cached quotes are up (advances), down (declines),
   * or flat (unchanged) based on change%.
   */
  getBreadth(): {
    advances: number;
    declines: number;
    unchanged: number;
    adRatio: number;
    total: number;
  } {
    let advances = 0;
    let declines = 0;
    let unchanged = 0;

    for (const quote of this.quoteCache.values()) {
      if (quote.changePercent > 0) advances++;
      else if (quote.changePercent < 0) declines++;
      else unchanged++;
    }

    const total = advances + declines + unchanged;
    const adRatio =
      declines > 0
        ? Math.round((advances / declines) * 100) / 100
        : advances > 0
          ? advances
          : 0;

    return { advances, declines, unchanged, adRatio, total };
  }

  /** Mapping from sector index symbol to a friendly sector name. */
  private static readonly SECTOR_NAME_MAP: Record<string, string> = {
    'NIFTY IT': 'IT',
    'NIFTY BANK': 'Banking',
    'NIFTY PHARMA': 'Pharma',
    'NIFTY AUTO': 'Auto',
    'NIFTY FMCG': 'FMCG',
    'NIFTY METAL': 'Metal',
    'NIFTY ENERGY': 'Energy',
    'NIFTY REALTY': 'Realty',
    'NIFTY INFRA': 'Infra',
    'NIFTY MEDIA': 'Media',
    'NIFTY PSU BANK': 'PSU Bank',
    'NIFTY PVT BANK': 'Pvt Bank',
    'NIFTY FIN SERVICE': 'Fin Services',
    'NIFTY HEALTHCARE': 'Healthcare',
    'NIFTY CONSUMER': 'Consumer',
  };

  /** Main index symbols to exclude from sector performance. */
  private static readonly MAIN_INDEX_SYMBOLS = new Set([
    'NIFTY',
    'BANKNIFTY',
    'FINNIFTY',
    'SENSEX',
    'NIFTY 50',
    'NIFTY BANK',
  ]);

  /**
   * Get sector performance from cached sector index quotes.
   * Filters for sector index tokens (starting with "99926") that are not
   * main indices, maps to friendly sector names, and sorts by changePercent
   * descending (best performing sectors first).
   */
  getSectorPerformance(): Array<{
    sector: string;
    symbol: string;
    changePercent: number;
    ltp: number;
  }> {
    const sectors: Array<{
      sector: string;
      symbol: string;
      changePercent: number;
      ltp: number;
    }> = [];

    for (const quote of this.quoteCache.values()) {
      // Only include sector index tokens (starting with "99926"). Read the
      // token off the quote (the cache key is now the composite
      // `${exchange}:${token}`, not the bare token).
      if (!quote.token.startsWith('99926')) continue;

      // Exclude main indices
      if (MarketFeedService.MAIN_INDEX_SYMBOLS.has(quote.symbol)) continue;

      const friendlyName =
        MarketFeedService.SECTOR_NAME_MAP[quote.symbol] ?? quote.symbol;

      sectors.push({
        sector: friendlyName,
        symbol: quote.symbol,
        changePercent: quote.changePercent,
        ltp: quote.ltp,
      });
    }

    // Sort by changePercent descending (best performing first)
    sectors.sort((a, b) => b.changePercent - a.changePercent);

    return sectors;
  }

  /**
   * Get the set of all currently subscribed tokens.
   */
  getSubscribedTokens(): string[] {
    return [
      ...Array.from(this.primaryTokens),
      ...Array.from(this.scanTokens),
      ...Array.from(this.viewingTokens.keys()),
    ];
  }

  /**
   * Check whether we are within Indian market hours.
   */
  isMarketOpen(): boolean {
    const now = new Date();

    // Use Intl to reliably get IST time regardless of server timezone
    const istParts = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hour12: false,
    }).formatToParts(now);

    const weekday = istParts.find((p) => p.type === 'weekday')?.value ?? '';
    if (weekday === 'Sat' || weekday === 'Sun') return false;

    const hours = Number(istParts.find((p) => p.type === 'hour')?.value ?? 0);
    const minutes = Number(istParts.find((p) => p.type === 'minute')?.value ?? 0);
    const totalMinutes = hours * 60 + minutes;

    // NSE/BSE hours
    const nseOpen = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
    const nseClose = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;
    const nseIsOpen = totalMinutes >= nseOpen && totalMinutes <= nseClose;

    // MCX hours (9:00 AM – 11:30 PM IST)
    const mcxOpen = MCX_OPEN_HOUR * 60 + MCX_OPEN_MINUTE;
    const mcxClose = MCX_CLOSE_HOUR * 60 + MCX_CLOSE_MINUTE;
    const mcxIsOpen = totalMinutes >= mcxOpen && totalMinutes <= mcxClose;

    return nseIsOpen || mcxIsOpen;
  }

  // ------------------------------------------------------------------
  //  Core tick handler
  // ------------------------------------------------------------------

  /**
   * Process an incoming tick from the broker adapter.
   * This is the central data distribution point.
   */
  private handleTick(tick: TickData): void {
    try {
      // Normalize the symbol: WebSocket ticks often arrive without a symbol
      // name (or with a different format than our INDICES constants).
      // Ensure we always use our canonical symbol for consistent frontend filtering.
      this.normalizeTickSymbol(tick);

      // 1. Update the level book BEFORE building the quote so the quote can
      //    read the freshly-rolled VWAP. LevelBookService rolls VWAP /
      //    today H/L / spot and tracks staleness off this same tick stream.
      this.levelBookService?.updateFromTick({
        token: tick.token,
        ltp: tick.ltp,
        volume: tick.volume,
        timestamp: tick.timestamp,
      });

      // 2. Build the quote (now annotated with vwap when the book has it)
      //    and update the in-memory cache.
      const quote = this.tickToQuote(tick);
      this.quoteCache.set(this.quoteKey(quote.exchange, tick.token), quote);

      // 3. Dispatch to watch monitor tick handler (Stage 2 watch lifecycle)
      this.dispatchWatchTick(tick.token, tick.ltp, tick.timestamp);

      // 4. Publish to Redis for cross-service distribution
      this.publishToRedis(tick);

      // 5. Pass to candle aggregator
      this.candleAggregator.processTick(tick);

      // 6. Emit live tick to frontend via WebSocket gateway
      this.gateway.emitTick(quote);
    } catch (error) {
      this.logger.error(
        `Error processing tick for ${tick.token}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ------------------------------------------------------------------
  //  Redis pub/sub
  // ------------------------------------------------------------------

  private async initRedis(): Promise<void> {
    try {
      const redisHost = this.configService.get<string>('redis.host', 'localhost');
      const redisPort = this.configService.get<number>('redis.port', 6379);
      const redisPassword = this.configService.get<string>('redis.password') || undefined;
      // TLS-only managed Redis (Upstash/ElastiCache). undefined => plain TCP.
      const redisTls = this.configService.get<Record<string, never> | undefined>('redis.tls');

      const redisOptions = { host: redisHost, port: redisPort, password: redisPassword, tls: redisTls };

      this.redisPub = new Redis(redisOptions);
      this.redisSub = new Redis(redisOptions);

      this.redisPub.on('error', (err) =>
        this.logger.error(`Redis pub error: ${err.message}`),
      );
      this.redisSub.on('error', (err) =>
        this.logger.error(`Redis sub error: ${err.message}`),
      );

      // Subscribe to ticks channel for cross-service communication
      await this.redisSub.subscribe(REDIS_TICKS_CHANNEL);
      this.redisSub.on('message', (_channel, message) => {
        try {
          const tick: TickData = JSON.parse(message);
          tick.timestamp = new Date(tick.timestamp);
          // Update local cache from ticks published by other processes
          const quote = this.tickToQuote(tick);
          this.quoteCache.set(this.quoteKey(quote.exchange, tick.token), quote);
        } catch {
          // Ignore malformed messages
        }
      });

      this.logger.log('Redis pub/sub connections established');
    } catch (error) {
      this.logger.error(
        `Failed to initialize Redis: ${error instanceof Error ? error.message : error}. ` +
          'Continuing without Redis pub/sub.',
      );
    }
  }

  private publishToRedis(tick: TickData): void {
    if (!this.redisPub) return;

    this.redisPub
      .publish(REDIS_TICKS_CHANNEL, JSON.stringify(tick))
      .catch((err) =>
        this.logger.error(`Redis publish error: ${err.message}`),
      );
  }

  // ------------------------------------------------------------------
  //  Helpers
  // ------------------------------------------------------------------

  /**
   * Resolve dynamic MCX commodity tokens by searching for the nearest-expiry
   * active futures contract via the broker's searchScrip API.
   *
   * MCX futures tokens change every month when contracts expire, so we cannot
   * hardcode them. This method looks up each commodity symbol, picks the
   * contract with the nearest expiry date, and updates the COMMODITIES
   * constant in-place so the rest of the system uses the correct token.
   */
  private async resolveCommodityTokens(): Promise<void> {
    if (!this.brokerAdapter) return;

    this.logger.log('Resolving dynamic MCX commodity tokens...');

    for (const [key, commodity] of Object.entries(COMMODITIES)) {
      // Always re-resolve: MCX FUTCOM contracts roll every month, so a
      // hardcoded token in the constants file goes stale within weeks of
      // any contract expiry. We previously short-circuited if the constant
      // was non-'0', which meant CRUDEOIL stayed pinned to the April
      // contract long after expiry — visible chart gaps and wrong prices.

      try {
        // Try multiple search patterns to find futures contracts.
        // Angel One searchScrip for "NATURALGAS" returns mostly options (50 cap).
        // Searching for "GOLDM" or commodity + month abbreviation finds futures.
        const searchQueries = [
          `${commodity.symbol}M`,   // e.g., "GOLDM", "SILVERM" (mini contracts)
          commodity.symbol,          // e.g., "GOLD", "NATURALGAS"
        ];

        let allResults: any[] = [];
        for (const query of searchQueries) {
          const results = await this.brokerAdapter!.searchInstruments(query, 'MCX');
          if (Array.isArray(results)) {
            allResults = allResults.concat(results);
          }
        }

        if (allResults.length === 0) {
          this.logger.warn(
            `No MCX contracts found for ${commodity.symbol} — token remains unresolved`,
          );
          continue;
        }

        // Filter for futures contracts (symbol contains "FUT").
        const futuresContracts = allResults
          .filter((r: any) => {
            const sym = (r.tradingsymbol ?? r.symbol ?? '').toUpperCase();
            return sym.includes('FUT') && sym.startsWith(commodity.symbol.toUpperCase());
          })
          .map((r: any) => ({
            token: String(r.symboltoken ?? r.token ?? ''),
            tradingsymbol: r.tradingsymbol ?? r.symbol ?? '',
            expiry: r.expiry ? new Date(r.expiry) : null,
          }))
          .filter((c) => c.token && c.token !== '0');

        if (futuresContracts.length === 0) {
          this.logger.warn(
            `No FUT contracts found for ${commodity.symbol} in search results`,
          );
          continue;
        }

        // Sort by expiry ascending — nearest expiry first
        futuresContracts.sort((a, b) => {
          if (!a.expiry && !b.expiry) return 0;
          if (!a.expiry) return 1;
          if (!b.expiry) return -1;
          return a.expiry.getTime() - b.expiry.getTime();
        });

        // Pick the nearest-expiry contract that hasn't already expired
        const now = new Date();
        const activeContract =
          futuresContracts.find((c) => c.expiry && c.expiry >= now) ??
          futuresContracts[0];

        // Update the mutable COMMODITIES constant in-place
        COMMODITIES[key].token = activeContract.token;

        this.logger.log(
          `Resolved ${commodity.symbol} → token ${activeContract.token} (${activeContract.tradingsymbol})`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to resolve token for ${commodity.symbol}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  /**
   * Wait for the auth service to become authenticated, then seed the
   * quote cache and start the WebSocket feed.
   */
  private async autoStart(): Promise<void> {
    if (!this.brokerAdapter) {
      this.logger.log(
        'Broker not authenticated — feed will not auto-start. ' +
          'Configure Angel One credentials in .env to enable live data.',
      );
      return;
    }

    // Poll for auth readiness (auth service may still be retrying login)
    const maxWaitMs = 15_000;
    const pollMs = 1_000;
    const start = Date.now();

    while (!this.angelOneAuth.isAuthenticated() && Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollMs));
    }

    if (!this.angelOneAuth.isAuthenticated()) {
      this.logger.log(
        'Broker not authenticated — feed will not auto-start. ' +
          'Configure Angel One credentials in .env to enable live data.',
      );
      return;
    }

    // Resolve dynamic MCX commodity tokens before seeding
    await this.resolveCommodityTokens();

    // Always seed the quote cache from REST first
    await this.seedQuoteCacheFromRest();

    // Attempt WebSocket feed — fall back to REST polling on failure
    try {
      this.logger.log('Auth detected — connecting broker adapter and starting WebSocket feed...');
      await this.brokerAdapter.connect();
      await this.startFeed();
    } catch (error) {
      this.logger.warn(
        `WebSocket feed failed: ${error instanceof Error ? error.message : error}`,
      );
      this.logger.log('Falling back to REST polling (5s interval)');
      this.startRestPolling();
    }
  }

  /**
   * Manually start the market data feed.
   * Tries WebSocket first, falls back to REST polling if WebSocket fails.
   * Called from the /api/market-data/feed/start endpoint.
   */
  async manualStartFeed(): Promise<{
    feedActive: boolean;
    feedMode: string;
    message: string;
  }> {
    if (this.feedActive && this.feedMode === 'websocket') {
      return {
        feedActive: true,
        feedMode: 'websocket',
        message: 'Feed is already running in WebSocket mode.',
      };
    }

    if (!this.brokerAdapter) {
      return {
        feedActive: false,
        feedMode: 'none',
        message: 'No broker adapter available. Configure Angel One credentials in .env.',
      };
    }

    if (!this.angelOneAuth.isAuthenticated()) {
      return {
        feedActive: false,
        feedMode: 'none',
        message: 'Broker is not authenticated. Ensure Angel One login succeeds first.',
      };
    }

    // Stop any existing REST polling before attempting WebSocket
    this.stopRestPolling();
    this.stopWsReconnectTimer();

    // If feed was running in rest-polling mode, stop it so startFeed() can re-init
    if (this.feedActive) {
      this.feedActive = false;
      this.feedMode = 'none';
    }

    // Seed cache first
    await this.seedQuoteCacheFromRest();

    // Attempt WebSocket
    try {
      this.logger.log('Manual feed start — attempting WebSocket connection...');
      await this.brokerAdapter.connect();
      await this.startFeed();
      return {
        feedActive: true,
        feedMode: 'websocket',
        message: 'Feed started in WebSocket mode.',
      };
    } catch (error) {
      this.logger.warn(
        `WebSocket feed failed, falling back to REST polling: ${error instanceof Error ? error.message : error}`,
      );
      this.startRestPolling();
      return {
        feedActive: true,
        feedMode: 'rest-polling',
        message: `WebSocket failed (${error instanceof Error ? error.message : 'unknown error'}). Feed running via REST polling (5s interval).`,
      };
    }
  }

  // ------------------------------------------------------------------
  //  REST polling fallback
  // ------------------------------------------------------------------

  /**
   * Start REST-based polling as a fallback when WebSocket is unavailable.
   * Polls every 5 seconds for all subscribed tokens (or default indices).
   * Also schedules periodic WebSocket reconnect attempts every 60 seconds.
   */
  private startRestPolling(): void {
    if (this.restPollingInterval) {
      this.logger.log('REST polling is already active');
      return;
    }

    if (!this.brokerAdapter) return;

    // Ensure we have tokens to poll — default to indices, sectors, stocks, and commodities
    if (this.primaryTokens.size === 0) {
      const defaultTokens = [
        ...(Object.values(INDICES) as Array<{ token: string }>).map((idx) => idx.token),
        ...(Object.values(SECTOR_INDICES) as Array<{ token: string }>).map((s) => s.token),
        ...(Object.values(MAJOR_STOCKS) as Array<{ token: string }>).map((s) => s.token),
        ...(Object.values(COMMODITIES) as Array<{ token: string }>).map((c) => c.token),
      ];
      // Deduplicate (some sector tokens overlap with INDICES) and skip unresolved ('0')
      for (const token of new Set(defaultTokens)) {
        if (token !== '0') this.primaryTokens.add(token);
      }
    }

    this.feedActive = true;
    this.feedMode = 'rest-polling';
    this.broadcastStatus();

    // Run the first poll immediately
    this.pollQuotesViaRest();

    // Set up recurring REST poll
    this.restPollingInterval = setInterval(() => {
      this.pollQuotesViaRest();
    }, this.REST_POLL_INTERVAL_MS);

    this.logger.log(
      `REST polling started — polling ${this.primaryTokens.size + this.scanTokens.size} tokens every ${this.REST_POLL_INTERVAL_MS / 1000}s`,
    );

    // Schedule periodic WebSocket reconnect attempts
    this.startWsReconnectTimer();
  }

  /**
   * Stop REST polling.
   */
  private stopRestPolling(): void {
    if (this.restPollingInterval) {
      clearInterval(this.restPollingInterval);
      this.restPollingInterval = null;
      this.logger.log('REST polling stopped');
    }
  }

  /**
   * Poll live quotes for all subscribed tokens via the REST API
   * and process them through the standard tick handler pipeline.
   */
  private async pollQuotesViaRest(): Promise<void> {
    if (!this.brokerAdapter) return;

    const allTokens = [
      ...Array.from(this.primaryTokens),
      ...Array.from(this.scanTokens),
    ];

    if (allTokens.length === 0) return;

    // Build a token-to-exchange map from all known token sets
    const indexMap = new Map<string, string>();
    for (const idx of Object.values(INDICES)) {
      indexMap.set(idx.token, idx.exchange);
    }
    for (const s of Object.values(SECTOR_INDICES)) {
      indexMap.set(s.token, s.exchange);
    }
    for (const s of Object.values(MAJOR_STOCKS)) {
      indexMap.set(s.token, s.exchange);
    }
    for (const c of Object.values(COMMODITIES)) {
      indexMap.set(c.token, c.exchange);
    }

    const results = await Promise.allSettled(
      allTokens.map(async (token) => {
        const exchange = indexMap.get(token) ?? 'NSE';
        const tick = await this.brokerAdapter!.getLiveQuote(token, exchange);
        // Symbol normalization is handled centrally in handleTick()
        this.handleTick(tick);
      }),
    );

    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(`REST poll: ${failed}/${allTokens.length} token fetches failed`);
    }
  }

  /**
   * Periodically attempt to upgrade from REST polling to WebSocket.
   */
  private startWsReconnectTimer(): void {
    this.stopWsReconnectTimer();

    this.wsReconnectInterval = setInterval(async () => {
      if (this.feedMode === 'websocket') {
        // Already on WebSocket — no need to keep trying
        this.stopWsReconnectTimer();
        return;
      }

      if (!this.brokerAdapter || !this.angelOneAuth.isAuthenticated()) return;

      this.logger.log('Attempting to upgrade from REST polling to WebSocket...');

      try {
        await this.brokerAdapter.connect();

        // Connection succeeded — switch to WebSocket mode
        this.stopRestPolling();
        this.feedActive = false; // Reset so startFeed() proceeds
        this.feedMode = 'none';
        await this.startFeed();

        this.logger.log('Successfully upgraded to WebSocket feed');
        this.stopWsReconnectTimer();
      } catch (error) {
        this.logger.warn(
          `WebSocket upgrade attempt failed, continuing REST polling: ${error instanceof Error ? error.message : error}`,
        );
      }
    }, this.WS_RECONNECT_RETRY_MS);

    this.logger.log(
      `WebSocket reconnect timer started — retrying every ${this.WS_RECONNECT_RETRY_MS / 1000}s`,
    );
  }

  /**
   * Stop the periodic WebSocket reconnect timer.
   */
  private stopWsReconnectTimer(): void {
    if (this.wsReconnectInterval) {
      clearInterval(this.wsReconnectInterval);
      this.wsReconnectInterval = null;
    }
  }

  /**
   * Fetch LTP data from Angel One REST API for all indices, sector
   * indices, and major stocks, then seed the in-memory quote cache.
   * This ensures the UI shows real prices even when the WebSocket feed
   * hasn't started or the market is closed.
   */
  private async seedQuoteCacheFromRest(): Promise<void> {
    if (!this.brokerAdapter) return;

    // Combine indices, sector indices, major stocks, and commodities for seeding
    const indexEntries = Object.values(INDICES);
    const sectorEntries = Object.values(SECTOR_INDICES)
      // Skip sector tokens that overlap with INDICES (e.g. NIFTY IT, NIFTY BANK)
      .filter((s) => !indexEntries.some((idx) => idx.token === s.token));
    const stockEntries = Object.values(MAJOR_STOCKS);
    const commodityEntries = Object.values(COMMODITIES).filter((c) => c.token !== '0');
    const allEntries = [
      ...indexEntries.map((e) => ({ ...e, type: 'index' as const })),
      ...sectorEntries.map((e) => ({ ...e, type: 'sector' as const })),
      ...stockEntries.map((e) => ({ ...e, type: 'stock' as const })),
      ...commodityEntries.map((e) => ({ ...e, type: 'commodity' as const })),
    ];

    this.logger.log(
      `Seeding quote cache for ${allEntries.length} instruments ` +
        `(${indexEntries.length} indices, ${sectorEntries.length} sector indices, ${stockEntries.length} stocks, ${commodityEntries.length} commodities) via REST API...`,
    );

    const results = await Promise.allSettled(
      allEntries.map(async (entry) => {
        const tick = await this.brokerAdapter!.getLiveQuote(entry.token, entry.exchange);
        this.normalizeTickSymbol(tick); // Use canonical symbol names
        const quote = this.tickToQuote(tick);
        quote.exchange = entry.exchange as Exchange;
        this.quoteCache.set(this.quoteKey(entry.exchange, entry.token), quote);
        return entry.symbol;
      }),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed > 0) {
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason?.message ?? r.reason);
      this.logger.warn(
        `Quote seed: ${succeeded} succeeded, ${failed} failed — ${errors.join('; ')}`,
      );
    } else {
      this.logger.log(`Quote cache seeded with ${succeeded} quotes`);
    }
  }

  /**
   * Normalise the symbol field on an incoming tick so it matches the
   * canonical names used in the INDICES constant and the frontend store.
   *
   * WebSocket ticks from Angel One often arrive with an empty symbol or a
   * different format (e.g. "Nifty 50" instead of "NIFTY"). REST API ticks
   * can also have broker-specific trading symbol names. We look up the
   * token in INDICES first, then fall back to the in-memory instrument
   * cache to ensure consistent naming across the system.
   */
  private normalizeTickSymbol(tick: TickData): void {
    // Fast path: check INDICES constant (covers the 6 major indices)
    const indexEntry = Object.values(INDICES).find((idx) => idx.token === tick.token);
    if (indexEntry) {
      tick.symbol = indexEntry.symbol;
      return;
    }

    // Check sector indices
    const sectorEntry = Object.values(SECTOR_INDICES).find((s) => s.token === tick.token);
    if (sectorEntry) {
      tick.symbol = sectorEntry.symbol;
      return;
    }

    // Check major stocks
    const stockEntry = Object.values(MAJOR_STOCKS).find((s) => s.token === tick.token);
    if (stockEntry) {
      tick.symbol = stockEntry.symbol;
      return;
    }

    // Check commodities
    const commodityEntry = Object.values(COMMODITIES).find((c) => c.token === tick.token);
    if (commodityEntry) {
      tick.symbol = commodityEntry.symbol;
      return;
    }

    // Fallback: use cached instrument data if the symbol is missing or empty.
    // getQuote() resolves the composite-keyed cache token-only (equity-venue
    // semantics) — adequate for symbol-name backfill.
    if (!tick.symbol || tick.symbol.trim() === '') {
      const cached = this.getQuote(tick.token);
      if (cached?.symbol) {
        tick.symbol = cached.symbol;
      }
    }
  }

  /**
   * Resolve the exchange for a given token by checking all known constant maps.
   * Returns the matching Exchange enum value, or Exchange.NSE as a last resort.
   */
  private getExchangeForToken(token: string): Exchange {
    const indexEntry = Object.values(INDICES).find((idx) => idx.token === token);
    if (indexEntry) return indexEntry.exchange as Exchange;

    const sectorEntry = Object.values(SECTOR_INDICES).find((s) => s.token === token);
    if (sectorEntry) return sectorEntry.exchange as Exchange;

    const stockEntry = Object.values(MAJOR_STOCKS).find((s) => s.token === token);
    if (stockEntry) return stockEntry.exchange as Exchange;

    const commodityEntry = Object.values(COMMODITIES).find((c) => c.token === token);
    if (commodityEntry) return commodityEntry.exchange as Exchange;

    return Exchange.NSE;
  }

  private tickToQuote(tick: TickData): Quote {
    const tickExchange =
      (tick as any).exchange ?? this.getExchangeForToken(tick.token);
    const previousQuote = this.quoteCache.get(
      this.quoteKey(tickExchange, tick.token),
    );
    const prevClose = previousQuote?.close ?? tick.close;
    const change = tick.ltp - prevClose;
    const changePercent = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    // Read intraday VWAP from the level book if it's tracking this token.
    // Books that haven't accumulated enough volume yet report vwap=0; we
    // omit the field in that case so the frontend can render "—" cleanly
    // instead of a misleading 0.00 stat.
    const book = this.levelBookService?.getLevels(tick.token) ?? null;
    const vwap = book && book.vwap > 0 ? book.vwap : undefined;

    // Resolve the symbol by (exchange, token) so a cross-segment token collision
    // (e.g. 509 = NSE MAZDOCK-EQ vs MCX SSUGARMKOLCOM) labels the quote with the
    // RIGHT instrument for its exchange, not whichever loaded last in the
    // token-only cache. Falls back to the tick's own symbol if unresolved.
    const resolvedSymbol =
      this.instrumentService.getByExchangeTokenSync(tickExchange, tick.token)?.symbol ??
      tick.symbol;

    const quote: Quote = {
      symbol: resolvedSymbol,
      token: tick.token,
      exchange: tickExchange,
      ltp: tick.ltp,
      open: tick.open,
      high: tick.high,
      low: tick.low,
      close: tick.close,
      volume: tick.volume,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round(changePercent * 100) / 100,
      timestamp: tick.timestamp,
    };
    if (vwap !== undefined) quote.vwap = vwap;
    return quote;
  }

  private async registerTokensWithBroker(tokens: string[]): Promise<void> {
    if (!this.brokerAdapter || !this.feedCallback) return;

    try {
      this.brokerAdapter.subscribeToFeed(tokens, this.feedCallback);
    } catch (error) {
      this.logger.error(
        `Failed to register tokens with broker: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Ensure the candle aggregator has instrumentId mappings for the given tokens.
   */
  private async ensureInstrumentMappings(tokens: string[]): Promise<void> {
    for (const token of tokens) {
      const instrument = await this.instrumentService.getByToken(token);
      if (instrument) {
        this.candleAggregator.setTokenInstrumentId(token, instrument.id);
      }
    }
  }

  private broadcastStatus(): void {
    this.gateway.emitConnectionStatus({
      connected: this.feedActive,
      activeSubscriptions: this.primaryTokens.size + this.scanTokens.size,
      timestamp: new Date(),
    });
  }

  // ------------------------------------------------------------------
  //  Watch monitor subscription management (Stage 2)
  // ------------------------------------------------------------------

  /**
   * Subscribe a watch entry to a token for live ticks. Idempotent.
   */
  subscribeForWatch(token: string, watchEntryId: string): void {
    let set = this.watchTokens.get(token);
    if (!set) {
      set = new Set();
      this.watchTokens.set(token, set);
      if (
        !this.primaryTokens.has(token) &&
        !this.scanTokens.has(token) &&
        !this.viewingTokens.has(token)
      ) {
        try {
          this.brokerAdapter?.subscribeToFeed?.([token], () => {
            // Ticks are dispatched via the shared feedCallback; this no-op
            // callback just satisfies the adapter contract for new tokens.
          });
        } catch (err) {
          this.logger.warn(
            `subscribeForWatch broker subscribe failed for ${token}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    set.add(watchEntryId);

    let reverse = this.watchEntryTokens.get(watchEntryId);
    if (!reverse) {
      reverse = new Set();
      this.watchEntryTokens.set(watchEntryId, reverse);
    }
    reverse.add(token);
  }

  unsubscribeForWatch(token: string, watchEntryId: string): void {
    const set = this.watchTokens.get(token);
    if (set) {
      set.delete(watchEntryId);
      if (set.size === 0) {
        this.watchTokens.delete(token);
        if (
          !this.primaryTokens.has(token) &&
          !this.scanTokens.has(token) &&
          !this.viewingTokens.has(token)
        ) {
          try {
            const adapter = this.brokerAdapter as unknown as {
              unsubscribeFromFeed?: (tokens: string[]) => void;
            } | null;
            adapter?.unsubscribeFromFeed?.([token]);
          } catch (err) {
            this.logger.warn(
              `unsubscribeForWatch broker unsubscribe failed for ${token}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
    }
    const reverse = this.watchEntryTokens.get(watchEntryId);
    if (reverse) {
      reverse.delete(token);
      if (reverse.size === 0) this.watchEntryTokens.delete(watchEntryId);
    }
  }

  /**
   * Register the per-tick handler for watch monitor entries. Called once
   * during module init by WatchMonitorModule.
   */
  registerWatchTickHandler(
    handler: (token: string, ltp: number, ts: Date) => void | Promise<void>,
  ): void {
    this.watchTickHandlers.push(handler);
  }

  /**
   * Internal: invoked by the existing tick processing loop. Fans out the
   * tick to the watch handler if any watch entries are subscribed.
   */
  protected dispatchWatchTick(token: string, ltp: number, ts: Date): void {
    if (this.watchTickHandlers.length === 0) return;
    const subs = this.watchTokens.get(token);
    if (!subs || subs.size === 0) return;
    for (const handler of this.watchTickHandlers) try {
      const r = handler(token, ltp, ts);
      if (r instanceof Promise) {
        r.catch((err) => {
          this.logger.warn(
            `watchTickHandler threw for ${token}: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    } catch (err) {
      this.logger.warn(
        `watchTickHandler sync-threw for ${token}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
