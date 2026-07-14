import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  Body,
  HttpException,
  HttpStatus,
  HttpCode,
  Logger,
  BadRequestException,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam } from '@nestjs/swagger';
import { MarketFeedService } from '../services/market-feed.service';
import { InstrumentService } from '../services/instrument.service';
import { CandleAggregatorService } from '../services/candle-aggregator.service';
import { MarketDataRepository } from '../repositories/market-data.repository';
import { AngelOneAdapterService } from '../services/angel-one-adapter.service';
import { CommodityRollService } from '../services/commodity-roll.service';
import { GapDetectorService } from '../services/gap-detector.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import {
  SubscribeDto,
  UnsubscribeDto,
  SearchInstrumentDto,
  GetCandlesQueryDto,
  GetOIQueryDto,
} from '../dto/market-data.dto';
import {
  INDICES,
  SECTOR_INDICES,
  MAJOR_STOCKS,
  COMMODITIES,
} from '@td/shared/constants';
import { seriesCautionary } from '../../trade-engine/utils/cautionary';

/**
 * Look up a symbol and exchange for a token from the known constant maps.
 * Returns `{ symbol, exchange }` if found, or `null` if the token is unknown.
 */
function resolveTokenFromConstants(
  token: string,
): { symbol: string; exchange: string } | null {
  for (const entry of Object.values(INDICES)) {
    if (entry.token === token) return { symbol: entry.symbol, exchange: entry.exchange };
  }
  for (const entry of Object.values(SECTOR_INDICES)) {
    if (entry.token === token) return { symbol: entry.symbol, exchange: entry.exchange };
  }
  for (const entry of Object.values(MAJOR_STOCKS)) {
    if (entry.token === token) return { symbol: entry.symbol, exchange: entry.exchange };
  }
  for (const entry of Object.values(COMMODITIES)) {
    if (entry.token === token) return { symbol: entry.symbol, exchange: entry.exchange };
  }
  return null;
}

/**
 * Per-request coalescing cache for the candles endpoint. Multiple users
 * (or a single user mashing refresh) hitting the same token+timeframe+
 * range within CANDLE_CACHE_TTL_MS share one in-flight broker call,
 * keeping us under Angel One's 3 req/sec historical rate limit.
 *
 * Module-scope rather than per-request so concurrent requests across
 * different connections coalesce too.
 */
interface CandleCacheEntry {
  promise: Promise<unknown>;
  expiresAt: number;
}
const candleCache = new Map<string, CandleCacheEntry>();
const CANDLE_CACHE_TTL_MS = 30_000;

@ApiTags('Market Data')
@Controller('api/market-data')
export class MarketDataController {
  private readonly logger = new Logger(MarketDataController.name);

  constructor(
    private readonly marketFeedService: MarketFeedService,
    private readonly instrumentService: InstrumentService,
    private readonly candleAggregator: CandleAggregatorService,
    private readonly repository: MarketDataRepository,
    private readonly angelOneAdapter: AngelOneAdapterService,
    private readonly commodityRollService: CommodityRollService,
    private readonly gapDetector: GapDetectorService,
    // Optional + forwardRef because LevelBookService lives in the
    // signal-generator module (which is @Global) and we don't want a
    // hard import cycle. Used only to seed quote responses outside
    // market hours when no live tick is cached.
    @Optional()
    @Inject(forwardRef(() => LevelBookService))
    private readonly levelBookService: LevelBookService | null,
  ) {}

  /**
   * GET /api/market-data/instruments
   * Search/list instruments with optional filters.
   */
  @Get('instruments')
  @ApiOperation({ summary: 'Search instruments' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'exchange', required: false })
  @ApiQuery({ name: 'segment', required: false })
  async getInstruments(
    @Query('search') search?: string,
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
  ) {
    try {
      if (!search || search.trim().length === 0) {
        // Return an empty set rather than all instruments
        return { instruments: [], count: 0 };
      }

      const trimmed = search.trim();

      // First search the local DB / in-memory cache
      const localResults = await this.instrumentService.search(
        trimmed,
        exchange,
        segment,
      );

      // If local results are sufficient, return them directly
      if (localResults.length >= 10) {
        return {
          instruments: localResults,
          count: localResults.length,
          source: 'local',
        };
      }

      // Fall back to Angel One searchScrip API for broader results.
      // Search across multiple exchanges unless a specific one was requested.
      const exchanges = exchange ? [exchange] : ['NSE', 'BSE', 'NFO', 'MCX'];
      const brokerResults: Array<{
        symbol: string;
        token: string;
        name: string;
        exchange: string;
        segment: string;
        lotSize: number;
        tickSize: number;
        expiry: null;
        strike: null;
        optionType: null;
      }> = [];

      const seenTokens = new Set(localResults.map((r) => r.token));

      for (const exch of exchanges) {
        try {
          const raw = await this.angelOneAdapter.searchInstruments(
            trimmed,
            exch,
          );

          for (const item of raw) {
            const token = String(item.symboltoken ?? item.token ?? '');
            if (!token || seenTokens.has(token)) continue;
            seenTokens.add(token);

            brokerResults.push({
              symbol: String(item.tradingsymbol ?? item.symbol ?? ''),
              token,
              name: String(item.symbolname ?? item.name ?? item.tradingsymbol ?? ''),
              exchange: String(item.exchange ?? exch),
              segment: String(item.exch_seg ?? exch),
              lotSize: parseInt(String(item.lotsize ?? '1')) || 1,
              tickSize: parseFloat(String(item.tick_size ?? '0.05')) || 0.05,
              expiry: null,
              strike: null,
              optionType: null,
            });
          }
        } catch (err) {
          this.logger.warn(
            `Angel One search on ${exch} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // Third-tier fallback: search the cached ScripMaster by company
      // NAME as well as trading symbol. Angel One's searchScrip API
      // matches symbol only — so a user typing "Varun Beverages" finds
      // nothing because the trading symbol is "VBL". This catches it.
      let masterResults: typeof brokerResults = [];
      const combinedSoFar = [...localResults, ...brokerResults];
      if (combinedSoFar.length < 5 && (!exchange || exchange === 'NSE' || exchange === 'BSE')) {
        try {
          const raw = await this.angelOneAdapter.searchInMaster(trimmed, {
            exchanges: exchange ? [exchange] : ['NSE', 'BSE'],
            limit: 20,
          });
          for (const item of raw) {
            const token = String(item.token ?? '');
            if (!token || seenTokens.has(token)) continue;
            seenTokens.add(token);
            masterResults.push({
              symbol: String(item.symbol ?? ''),
              token,
              name: String(item.name ?? item.symbol ?? ''),
              exchange: String(item.exch_seg ?? ''),
              segment: String(item.exch_seg ?? ''),
              lotSize: parseInt(String(item.lotsize ?? '1')) || 1,
              tickSize: parseFloat(String(item.tick_size ?? '0.05')) || 0.05,
              expiry: null,
              strike: null,
              optionType: null,
            });
          }
        } catch (err) {
          this.logger.warn(
            `ScripMaster name-search failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      const combined = [...localResults, ...brokerResults, ...masterResults].slice(0, 50);
      const sourceParts: string[] = [];
      if (localResults.length > 0) sourceParts.push('local');
      if (brokerResults.length > 0) sourceParts.push('angel_one');
      if (masterResults.length > 0) sourceParts.push('master');

      return {
        instruments: combined,
        count: combined.length,
        source: sourceParts.join('+') || 'local',
      };
    } catch (error) {
      this.logger.error(
        `Failed to search instruments: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to search instruments',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market-data/instruments/:token/candles
   *
   * Live-first chart data path. Pulls directly from Angel One every
   * request — the DB is no longer the primary source for the chart.
   *
   * Why: chart staleness has been the #1 source of bugs in this repo
   * (PDH/PDL pinned to expired contracts, daily-backfill cron didn't
   * fire, level-book cache held stale values, etc.). Going direct to
   * the broker eliminates the entire class.
   *
   * Tradeoffs:
   *   - First-paint latency goes from ~50ms (DB) to ~500-1500ms (Angel REST).
   *     WebSocket tick stream still updates the chart in real time after
   *     first paint, so subsequent renders feel instant.
   *   - In-memory request-coalescing cache (30s TTL) protects against
   *     refresh-mashing and shared chart loads across users — concurrent
   *     identical requests share one broker call.
   *   - DB fallback retained for degraded mode: if Angel fails (rate
   *     limit, transient outage), we serve whatever the DB has with a
   *     `source: 'db_fallback_stale'` marker so the chart can show
   *     SOMETHING rather than a blank canvas.
   *
   * Note: DB writes from this path are gone. The candle table is still
   * populated by the WS tick aggregator (live ticks → 1m candles) and
   * by the daily-backfill cron (post-close), which is what backtests
   * read from. Chart and backtest now use different read paths.
   */
  @Get('instruments/:token/candles')
  @ApiOperation({ summary: 'Get historical candles direct from Angel One (live, no DB cache)' })
  @ApiParam({ name: 'token', description: 'Instrument token' })
  async getCandles(
    @Param('token') token: string,
    @Query() query: GetCandlesQueryDto,
  ) {
    const from = new Date(query.from);
    const to = new Date(query.to);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new HttpException(
        'Invalid date format for from/to parameters',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Resolve exchange + symbol once. We still touch the DB for the
    // INSTRUMENT METADATA (cheap single-row read, ~5ms) — the heavy
    // candle table is what we're avoiding.
    const instrument = await this.instrumentService.getByToken(token);
    const constantEntry = resolveTokenFromConstants(token);
    const exchange =
      query.exchange ?? instrument?.exchange ?? constantEntry?.exchange ?? 'NSE';
    const symbol = instrument?.symbol ?? constantEntry?.symbol ?? token;

    // Coalesce concurrent identical requests onto a single broker call.
    // Cache key includes from/to so a chart panning to a different range
    // gets its own fetch.
    const cacheKey = `${exchange}:${token}:${query.timeframe}:${from.toISOString()}:${to.toISOString()}`;
    // Lazy sweep — drop expired entries on every read so the Map doesn't
    // grow unbounded. Cheap (one Map iteration per request).
    if (candleCache.size > 256) {
      const now = Date.now();
      for (const [k, v] of candleCache) {
        if (v.expiresAt <= now) candleCache.delete(k);
      }
    }
    const cached = candleCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.promise;
    }

    const fetchPromise = (async () => {
      try {
        const liveCandles = await this.angelOneAdapter.getHistoricalData(
          token,
          exchange,
          query.timeframe,
          from,
          to,
          'interactive', // user-facing chart fetch — jump the background queue
        );
        return {
          token,
          symbol,
          timeframe: query.timeframe,
          candles: liveCandles.map((c) => ({
            timestamp: c.timestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: Number(c.volume),
          })),
          count: liveCandles.length,
          source: 'angel_one_live',
        };
      } catch (err) {
        // Angel failed — degraded fallback to whatever the DB has so the
        // chart isn't blank. The aggregator keeps the DB ~current via WS
        // ticks + the daily-backfill cron, so this is usually serviceable
        // (just possibly minutes-to-hours stale on intraday timeframes).
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Angel candles fetch failed for ${exchange}:${token} ${query.timeframe} ` +
          `${query.from}→${query.to}: ${message}. Falling back to DB cache.`,
        );
        if (instrument) {
          const dbCandles = await this.repository.getCandles(
            instrument.id,
            query.timeframe,
            from,
            to,
          );
          if (dbCandles.length > 0) {
            return {
              token,
              symbol: instrument.symbol,
              timeframe: query.timeframe,
              candles: dbCandles.map((c) => ({
                timestamp: c.timestamp,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: Number(c.volume),
              })),
              count: dbCandles.length,
              source: 'db_fallback_stale',
              fallbackReason: message,
            };
          }
        }
        // No DB fallback either — propagate the broker error.
        throw new HttpException(
          `Failed to retrieve candles: ${message}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    })();

    candleCache.set(cacheKey, {
      promise: fetchPromise,
      expiresAt: Date.now() + CANDLE_CACHE_TTL_MS,
    });

    // On rejection, evict immediately so a retry doesn't return the
    // failed promise. Successful entries linger for the TTL.
    fetchPromise.catch(() => {
      candleCache.delete(cacheKey);
    });

    return fetchPromise;
  }

  /**
   * GET /api/market-data/instruments/:token/quote
   * Get the latest live quote for an instrument.
   *
   * Resolution order:
   *   1. Live tick cache (MarketFeedService.getQuote)
   *   2. LevelBookService lazy-build — outside market hours / for tokens
   *      not subscribed to the feed, this still gives the frontend usable
   *      OHLC + VWAP from the daily candle history. Critical for the
   *      LiveQuoteCard's VWAP/Day H/L/Open/PrevClose row, which would
   *      otherwise render "—" all evening.
   *   3. null with a message — only when both paths are empty.
   */
  @Get('instruments/:token/quote')
  @ApiOperation({ summary: 'Get latest quote for an instrument' })
  @ApiParam({ name: 'token', description: 'Instrument token' })
  @ApiQuery({ name: 'exchange', required: false })
  async getQuote(
    @Param('token') token: string,
    @Query('exchange') exchange?: string,
  ) {
    const quote = this.marketFeedService.getQuote(token);
    if (quote) {
      return { token, quote };
    }

    // No live tick — try the level book (seeds OHLC + VWAP from daily
    // candles even when the feed is offline / market is closed).
    const instrument = await this.instrumentService.getByToken(token);
    const constantEntry = resolveTokenFromConstants(token);
    const resolvedExchange =
      exchange ?? instrument?.exchange ?? constantEntry?.exchange ?? 'NSE';
    const resolvedSymbol = instrument?.symbol ?? constantEntry?.symbol ?? '';

    if (this.levelBookService) {
      try {
        const book = await this.levelBookService.lazyLoad(
          token,
          resolvedExchange,
          resolvedSymbol,
          'interactive', // user-facing quote fetch — jump the background queue
        );
        if (book) {
          // Build a minimal Quote from what the level book has. Volume
          // isn't tracked here (zeroed). LTP falls back to
          // spot → vwap → prevClose so we always have *some* number.
          // Change / changePercent are derived from prevClose when both
          // sides are non-zero — otherwise zeroed (the alternative is
          // showing a misleading -100% on first market-day data).
          const ltp = book.spot || book.vwap || book.prevClose || 0;
          const prevClose = book.prevClose || 0;
          const change = ltp && prevClose ? ltp - prevClose : 0;
          const changePercent = ltp && prevClose ? (change / prevClose) * 100 : 0;
          const seededQuote = {
            token,
            symbol: resolvedSymbol,
            exchange: resolvedExchange,
            ltp,
            open: 0, // not tracked by LevelBook
            high: book.todayHigh || 0,
            low: book.todayLow || 0,
            close: prevClose,
            volume: 0,
            change,
            changePercent,
            timestamp: book.lastTickAt ?? new Date(),
            vwap: book.vwap || undefined,
          };
          return {
            token,
            quote: seededQuote,
            message: 'Seeded from level book — no live tick cached',
          };
        }
      } catch (err) {
        this.logger.warn(
          `LevelBook seed for ${token} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (!instrument) {
      throw new HttpException(
        `Instrument not found for token: ${token}`,
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      token,
      symbol: instrument.symbol,
      quote: null,
      message: 'No live quote available. Token may not be subscribed to the feed.',
    };
  }

  /**
   * GET /api/market-data/instruments/:token/depth
   * Get 5-level market depth (bids/asks) for an instrument. Backs the
   * StockOverviewPanel's MarketDepthCard (polled every 2s on the
   * frontend; adapter caches at 1.5s so we don't hammer SmartAPI).
   *
   * Returns `{ depth: null }` (200, not 404) when the broker can't supply
   * depth — typical for indices and unentitled tokens — so the frontend
   * can render "Depth unavailable" rather than crash on a 404.
   */
  @Get('instruments/:token/depth')
  @ApiOperation({ summary: 'Get 5-level market depth for an instrument' })
  @ApiParam({ name: 'token', description: 'Instrument token' })
  @ApiQuery({ name: 'exchange', required: true })
  async getDepth(
    @Param('token') token: string,
    @Query('exchange') exchange: string,
  ) {
    if (!exchange) {
      throw new BadRequestException('exchange query parameter is required');
    }
    const depth = await this.angelOneAdapter.getMarketDepth(token, exchange);
    return { depth };
  }

  /**
   * GET /api/market-data/instruments/:token/oi
   * Get OI history for an instrument.
   */
  @Get('instruments/:token/oi')
  @ApiOperation({ summary: 'Get OI history for an instrument' })
  @ApiParam({ name: 'token', description: 'Instrument token' })
  async getOIHistory(
    @Param('token') token: string,
    @Query() query: GetOIQueryDto,
  ) {
    try {
      const instrument = await this.instrumentService.getByToken(token);
      if (!instrument) {
        return { token, symbol: '', oiHistory: [], count: 0 };
      }

      // Default to last 24 hours if no range specified
      const now = new Date();
      const from = query.from ? new Date(query.from) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const to = query.to ? new Date(query.to) : now;

      const oiHistory = await this.repository.getOIHistory(
        instrument.id,
        from,
        to,
      );

      return {
        token,
        symbol: instrument.symbol,
        oiHistory: oiHistory.map((snap) => ({
          oi: Number(snap.oi),
          oiChange: Number(snap.oiChange),
          volume: Number(snap.volume),
          timestamp: snap.timestamp,
        })),
        count: oiHistory.length,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to get OI history for ${token}: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to retrieve OI history',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market-data/indices
   * Get all major indices with live data.
   */
  @Get('indices')
  @ApiOperation({ summary: 'Get major market indices with live data' })
  async getIndices() {
    const indices = this.instrumentService.getIndices();

    return {
      indices: indices.map((idx) => ({
        key: idx.key,
        symbol: idx.symbol,
        token: idx.token,
        exchange: idx.exchange,
        quote: this.marketFeedService.getQuote(idx.token),
      })),
    };
  }

  /**
   * GET /api/market-data/breadth
   * Get market breadth (advances, declines, unchanged) from cached quotes.
   */
  @Get('breadth')
  @ApiOperation({ summary: 'Get market breadth from cached quotes' })
  getBreadth() {
    return this.marketFeedService.getBreadth();
  }

  /**
   * GET /api/market-data/sector-performance
   * Get sector index performance from cached quotes.
   */
  @Get('sector-performance')
  @ApiOperation({ summary: 'Get sector index performance' })
  getSectorPerformance() {
    return {
      sectors: this.marketFeedService.getSectorPerformance(),
    };
  }

  /**
   * POST /api/market-data/watchlist/subscribe
   * Subscribe tokens to the live market data feed.
   */
  @Post('watchlist/subscribe')
  @ApiOperation({ summary: 'Subscribe tokens to the live feed' })
  async subscribeFeed(@Body() dto: SubscribeDto) {
    try {
      const subscribed = await this.marketFeedService.subscribe(dto.tokens);

      return {
        subscribed,
        count: subscribed.length,
        message:
          subscribed.length < dto.tokens.length
            ? `Subscribed ${subscribed.length}/${dto.tokens.length} tokens. Some may already be subscribed or slot limit reached.`
            : `Successfully subscribed ${subscribed.length} tokens.`,
      };
    } catch (error) {
      this.logger.error(
        `Failed to subscribe tokens: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to subscribe to feed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/market-data/watchlist/unsubscribe
   * Unsubscribe tokens from the live feed.
   */
  @Post('watchlist/unsubscribe')
  @ApiOperation({ summary: 'Unsubscribe tokens from the live feed' })
  async unsubscribeFeed(@Body() dto: UnsubscribeDto) {
    try {
      const unsubscribed = await this.marketFeedService.unsubscribe(dto.tokens);

      return {
        unsubscribed,
        count: unsubscribed.length,
      };
    } catch (error) {
      this.logger.error(
        `Failed to unsubscribe tokens: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to unsubscribe from feed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/market-data/feed/start
   * Manually start the market data feed.
   * Tries WebSocket first, falls back to REST polling (5s interval).
   */
  @Post('feed/start')
  @ApiOperation({
    summary: 'Manually start market data feed (WebSocket or REST polling fallback)',
  })
  async startFeed() {
    try {
      const result = await this.marketFeedService.manualStartFeed();
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to start feed: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to start market data feed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market-data/status
   * Get feed connection status and active subscription counts.
   */
  @Get('status')
  @ApiOperation({ summary: 'Get feed connection status' })
  getStatus() {
    return {
      ...this.marketFeedService.getStatus(),
      marketOpen: this.marketFeedService.isMarketOpen(),
    };
  }

  @Get('debug/subscribed')
  @ApiOperation({ summary: 'Debug: list all currently subscribed tokens' })
  getSubscribedTokens() {
    return { tokens: this.marketFeedService.getSubscribedTokens() };
  }

  /**
   * GET /api/market-data/cautionary
   *
   * Pre-trade cautionary check for a stock. Pure & stateless: classifies
   * the Angel One tradingsymbol by its NSE series suffix (-BE / -BZ =
   * Trade-to-Trade, delivery-only, surveillance). Lets the order ticket
   * warn the user BEFORE a live INTRADAY order gets rejected by the broker
   * with "categorised under cautionary listings".
   *
   * Phase B: this endpoint will ALSO consult a persisted ASM/GSM/ESM list
   * (token-keyed) and OR its result with the series heuristic below. The
   * `token` / `exchange` params are accepted now so that lookup is a
   * drop-in addition without a frontend change.
   */
  @Get('cautionary')
  @ApiOperation({
    summary: 'Check whether a stock is cautionary / delivery-only (T2T)',
  })
  @ApiQuery({ name: 'symbol', required: true })
  @ApiQuery({ name: 'token', required: false })
  @ApiQuery({ name: 'exchange', required: false })
  getCautionary(
    @Query('symbol') symbol: string,
    // token / exchange are reserved for the Phase B persisted-list lookup.
    @Query('token') _token?: string,
    @Query('exchange') _exchange?: string,
  ) {
    const result = seriesCautionary(symbol ?? '');
    // ── Phase B goes here: consult the persisted ASM/GSM/ESM list keyed by
    // (token, exchange) and OR it into `result` before returning. ──
    return {
      symbol: symbol ?? '',
      cautionary: result.cautionary,
      reason: result.reason,
      deliveryOnly: result.deliveryOnly,
    };
  }

  /**
   * POST /api/market-data/instruments/:token/watch
   * Add a token to the live-feed "viewing" pool. Called by the chart
   * when the user opens a symbol that isn't in the universe-scanner or
   * primary watchlist (e.g. ONGC, SBIN, any stock via search). LRU-
   * managed, capped at 10 concurrent viewing subscriptions.
   */
  @Post('instruments/:token/watch')
  @HttpCode(HttpStatus.OK)
  async watchInstrument(
    @Param('token') token: string,
    @Query('exchange') exchange?: string,
  ) {
    if (!token || token === '0') {
      return { ok: false, reason: 'invalid token' };
    }
    if (!exchange) {
      return { ok: false, reason: 'exchange query param required' };
    }
    await this.marketFeedService.addViewing(token, exchange);
    return { ok: true, token, exchange };
  }

  /**
   * POST /api/market-data/debug-broker-fetch
   * TEMPORARY DIAGNOSTIC ENDPOINT — calls AngelOneAdapter.getHistoricalData
   * directly and optionally persists the rows. Used to diagnose
   * "broker returned no rows" silent failures and as a manual catch-up
   * trigger when the daily-backfill cron didn't fire. REMOVE once
   * the broker fetch is healthy again.
   *
   * Pass `persist: true` to upsert the returned rows into the candle
   * table (overwriting any existing row at the same instrumentId+timeframe+timestamp,
   * unlike saveCandles' skipDuplicates).
   */
  // ─── TEMPORARY DIAGNOSTIC — remove once the broker-data issue is resolved ───
  // Surfaces the RAW Angel One getCandleData response (status / message /
  // errorcode, and whether `data` is null vs []), which getHistoricalData
  // otherwise swallows into an empty array. Lets us tell a throttle
  // (data:null "exceeding access rate") apart from an auth failure
  // (data:null "Invalid Token") apart from a genuine empty window (data:[]).
  @Get('debug/angel-raw-candle')
  async debugAngelRawCandle(
    @Query('token') token = '2885',
    @Query('exchange') exchange = 'NSE',
    @Query('interval') interval = 'ONE_DAY',
    @Query('from') from = '2026-05-12 09:15',
    @Query('to') to = '2026-05-15 15:30',
  ) {
    const auth = this.angelOneAdapter.authService;
    const out: Record<string, unknown> = {
      isAuthenticated: auth.isAuthenticated(),
      clientId: auth.getClientId(),
      request: { token, exchange, interval, from, to },
    };
    try {
      const resp: any = await auth.getSmartApi().getCandleData({
        exchange,
        symboltoken: token,
        interval,
        fromdate: from,
        todate: to,
      });
      out.raw = {
        status: resp?.status,
        message: resp?.message ?? null,
        errorcode: resp?.errorcode ?? null,
        dataShape:
          resp?.data === null
            ? 'null'
            : Array.isArray(resp?.data)
              ? `array[${resp.data.length}]`
              : typeof resp?.data,
        dataSample: Array.isArray(resp?.data)
          ? resp.data.slice(0, 2)
          : resp?.data,
      };
    } catch (e) {
      out.exception =
        e instanceof Error ? { name: e.name, message: e.message } : String(e);
    }
    return out;
  }

  @Post('debug-broker-fetch')
  @HttpCode(HttpStatus.OK)
  async debugBrokerFetch(
    @Body()
    body: {
      token: string;
      exchange: string;
      timeframe: string;
      fromIso: string;
      toIso: string;
      persist?: boolean;
    },
  ) {
    const { token, exchange, timeframe, fromIso, toIso, persist, updateInstrumentTokenFrom } = body;
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return { ok: false, error: 'invalid fromIso / toIso' };
    }
    try {
      // Optionally repoint an existing instrument row to a new token before
      // fetching. Used to fix stale FUTCOM contract tokens (e.g. expired
      // COPPER row) in-place; the instrument's id stays stable so existing
      // candles tied to that id are preserved.
      let tokenRepointed: { from: string; to: string } | null = null;
      if (updateInstrumentTokenFrom && updateInstrumentTokenFrom !== token) {
        const stale = await this.instrumentService.getByToken(updateInstrumentTokenFrom);
        if (!stale) {
          return { ok: false, error: `no instrument record for stale token ${updateInstrumentTokenFrom}` };
        }
        await this.instrumentService.updateTokenById(stale.id, token);
        tokenRepointed = { from: updateInstrumentTokenFrom, to: token };
      }

      const rows = await this.angelOneAdapter.getHistoricalData(
        token, exchange, timeframe, from, to,
      );

      let persisted: number | null = null;
      if (persist && rows.length > 0) {
        const instrument = await this.instrumentService.getByToken(token);
        if (!instrument) {
          return { ok: false, error: `no instrument record for token ${token}` };
        }
        // Upsert in chunks of 50 sequentially. The previous Promise.all over
        // every row opened N concurrent Prisma connections — for a 10k-row
        // 1m backfill that exhausts the pool ("Timed out fetching a new
        // connection"). Sequential chunks keep concurrency bounded; chunk
        // size 50 keeps each batch's wall time small (a few hundred ms)
        // while still amortizing per-call overhead well below the
        // single-await-per-row alternative.
        const CHUNK_SIZE = 50;
        persisted = 0;
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
          const chunk = rows.slice(i, i + CHUNK_SIZE);
          const upsertResults = await Promise.all(
            chunk.map((c: any) =>
              this.repository.upsertCandle({
                instrumentId: instrument.id,
                timeframe,
                timestamp: new Date(c.timestamp),
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close),
                volume: Number(c.volume) || 0,
              }),
            ),
          );
          persisted += upsertResults.length;
        }
      }

      // After a successful persist, drop the cached level book so the
      // next chart/analyze call rebuilds PDH/PDL/atr14 from the freshly-
      // upserted candles. Without this, the chart keeps serving the
      // pre-catch-up values for up to LAZY_FRESH_MS (5 min) — the exact
      // failure mode that prompted adding the invalidate() method.
      let levelBookInvalidated = false;
      if (persist && persisted && this.levelBookService) {
        levelBookInvalidated = this.levelBookService.invalidate(token);
      }

      return {
        ok: true,
        rowCount: rows.length,
        persisted,
        tokenRepointed,
        levelBookInvalidated,
        first: rows[0] ?? null,
        last: rows.length > 0 ? rows[rows.length - 1] : null,
        sample: rows.slice(0, 3),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : null,
      };
    }
  }

  /**
   * POST /api/market-data/commodity-roll/trigger
   *
   * Manual trigger for the same commodity-roll logic that runs daily at
   * 08:30 IST via CommodityRollCron. Returns the per-symbol result so ops
   * can audit which contracts rolled, what the new tokens are, and whether
   * post-roll backfill / level-book invalidation / WS swap succeeded.
   *
   * Body (all optional):
   *   { dryRun?: boolean, symbols?: string[] }
   *
   *   dryRun:  detect changes but don't persist. Useful before a real roll.
   *   symbols: restrict to a subset (e.g. ["CRUDEOIL"]). Default: all
   *            commodities in the COMMODITIES constant.
   */
  @Post('commodity-roll/trigger')
  @HttpCode(HttpStatus.OK)
  async triggerCommodityRoll(
    @Body() body: { dryRun?: boolean; symbols?: string[] } = {},
  ) {
    const results = await this.commodityRollService.runRoll({
      dryRun: body.dryRun,
      symbols: body.symbols,
    });
    return {
      ok: true,
      dryRun: !!body.dryRun,
      rolled: results.filter((r) => r.status === 'ROLLED').length,
      noop: results.filter((r) => r.status === 'NOOP').length,
      errored: results.filter((r) => r.status === 'ERROR').length,
      results,
    };
  }

  /**
   * GET /api/market-data/commodities
   *
   * Live commodity snapshot fetched DIRECTLY from Angel One — no DB row, no feed
   * subscription, and no roll required. Resolves each tracked commodity's
   * current front-month token (cached ~6h so we don't pull the ~30MB
   * ScripMaster per request), then batch-fetches LTP over REST via the shared
   * feed session. Self-heals on monthly contract rollover because the
   * front-month is always re-resolved. `ltp` is null for any commodity the
   * account isn't entitled to quote (e.g. MCX segment not enabled).
   */
  @Get('commodities')
  async getCommodities() {
    const contracts = await this.commodityRollService.resolveFrontMonthTokens();
    const quotes = await this.angelOneAdapter.getQuotesBatch(
      'MCX',
      contracts.map((c) => c.token),
    );
    const commodities = contracts.map((c) => {
      const q = quotes.get(c.token);
      // Angel FULL mode gives previous close, so change = ltp − prevClose.
      const hasChange = q != null && q.close > 0;
      return {
        symbol: c.symbol,
        token: c.token,
        exchange: c.exchange,
        contractSymbol: c.contractSymbol,
        expiry: c.expiry,
        ltp: q?.ltp ?? null,
        open: q?.open ?? 0,
        high: q?.high ?? 0,
        low: q?.low ?? 0,
        close: q?.close ?? 0,
        volume: q?.volume ?? 0,
        change: hasChange ? Number((q!.ltp - q!.close).toFixed(2)) : 0,
        changePercent: hasChange ? Number((((q!.ltp - q!.close) / q!.close) * 100).toFixed(2)) : 0,
      };
    });
    return { commodities, count: commodities.length };
  }

  /**
   * POST /api/market-data/quotes
   *
   * Batch snapshot for arbitrary tokens, fetched directly from Angel (FULL
   * mode), grouped by exchange. Used by the watchlist poll so its rows stay live
   * even when the WebSocket tick feed stalls. Returns per-token ltp/OHLC +
   * computed change/changePercent (from the previous close). Tokens the account
   * can't quote are simply absent from the result.
   *
   * Body: { items: { token: string; exchange: string }[] }
   */
  @Post('quotes')
  @HttpCode(HttpStatus.OK)
  async getQuotes(@Body() body: { items?: { token: string; exchange: string }[] }) {
    const byExchange = new Map<string, string[]>();
    for (const it of body?.items ?? []) {
      if (!it?.token || !it?.exchange) continue;
      const ex = String(it.exchange).toUpperCase();
      (byExchange.get(ex) ?? byExchange.set(ex, []).get(ex)!).push(it.token);
    }
    const quotes: Array<{
      token: string;
      exchange: string;
      ltp: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      change: number;
      changePercent: number;
    }> = [];
    for (const [exchange, tokens] of byExchange) {
      const map = await this.angelOneAdapter.getQuotesBatch(exchange, tokens);
      for (const [token, q] of map) {
        const hasChange = q.close > 0;
        quotes.push({
          token,
          exchange,
          ltp: q.ltp,
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume,
          change: hasChange ? Number((q.ltp - q.close).toFixed(2)) : 0,
          changePercent: hasChange ? Number((((q.ltp - q.close) / q.close) * 100).toFixed(2)) : 0,
        });
      }
    }
    return { quotes, count: quotes.length };
  }

  /**
   * POST /api/market-data/gap-check/trigger
   *
   * Manual trigger for the same gap-detection logic that runs at boot
   * (deferred 10s after onModuleInit). Useful for ops to:
   *   - Audit what's stale right now without restarting the API
   *   - Run a dry-run to preview which instruments would be backfilled
   *   - Force a backfill mid-day after fixing a broker auth issue
   *
   * Body (all optional):
   *   { dryRun?: boolean }
   *
   *   dryRun: scan + classify but make no broker calls and write nothing.
   *           Returns DRY_RUN_GAP for any instrument that would have been
   *           backfilled in a non-dry run.
   */
  @Post('gap-check/trigger')
  @HttpCode(HttpStatus.OK)
  async triggerGapCheck(@Body() body: { dryRun?: boolean } = {}) {
    const results = await this.gapDetector.scanAndBackfill({ dryRun: body.dryRun });
    return {
      ok: true,
      dryRun: !!body.dryRun,
      checked: results.length,
      ok_count: results.filter((r) => r.status === 'OK').length,
      backfilled: results.filter((r) => r.status === 'BACKFILLED').length,
      gapsFound: results.filter((r) => r.status === 'DRY_RUN_GAP').length,
      errored: results.filter((r) => r.status === 'ERROR').length,
      // Skip OK rows in the response body to keep it skim-friendly when
      // most instruments are healthy. Errored / backfilled / gap rows
      // are what an operator wants to see.
      interesting: results.filter((r) => r.status !== 'OK'),
    };
  }
}
