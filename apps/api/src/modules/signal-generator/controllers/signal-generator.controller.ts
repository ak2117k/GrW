import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { SignalGeneratorService } from '../services/signal-generator.service';
import { StrategyRegistryService } from '../services/strategy-registry.service';
import { SignalRepository } from '../repositories/signal.repository';
import { UniverseScannerWorker } from '../workers/universe-scanner.worker';
import { SetupTrackerService } from '../services/setup-tracker.service';
import { SignalFilterDto } from '../dto/signal.dto';
import { ChartinkRepository } from '../../chartink/repositories/chartink.repository';
import { ZoneRepository } from '../repositories/zone.repository';
import { StrongZoneDetectorService } from '../services/strong-zone-detector.service';
import type { StrongZone } from '../types/zone.types';
import { LevelBookService } from '../services/level-book.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import type { CandleSource } from '../services/candle-source';
import { SrEvidenceService } from '../services/sr-evidence.service';
import { ChartContextService } from '../services/chart-context.service';
import type { ChartContextDto } from '../services/chart-context.service';
import { fitTrendLine, type TrendLine } from '../services/trend-line';
import { buildTradePlan, type TradePlan } from '../services/trade-plan';
import type { ProfileCandle as ChartCandle } from '../services/volume-profile';
import {
  HTF_FOR_TIMEFRAME,
  buildProjectionZones,
  type ProjectionZones,
} from '../services/zone-projection';

/** First argument that is genuinely a price. 0 and NaN are not prices. */
function firstPrice(...values: Array<number | null | undefined>): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/** Close of the last bar carrying one, or null for an empty/unusable series. */
function lastClose(candles: ChartCandle[]): number | null {
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i]?.close;
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}
import { isIntradayInterval, isSupportedInterval, normalizeInterval, lookbackDaysFor } from '../services/timeframe-lookback';
import { computeAtrFromCandles } from '../services/per-tf-atr';
import { AdminOnly, Roles, CurrentUser, AuthenticatedUser } from '../../../common/decorators';
import { SubscriptionService } from '../../subscription/subscription.service';
import type { Candle } from '../patterns/swing-points';
import { buildPatternMarkers } from '../patterns/to-markers';
import { PatternsResponseDto } from '../dto/pattern-marker.dto';
import { PatternCaptureService } from '../ml/pattern-capture.service';
import type { OhlcvCandle } from '../ml/pattern-observation.types';

/**
 * One mapper for every candle source (per-user session, shared adapter) so the
 * two branches cannot drift into producing subtly different rows.
 */
function toOhlcvRow(c: any) {
  return {
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: Number(c.volume),
  };
}

@AdminOnly()
@Controller('api/signals')
export class SignalGeneratorController {
  private readonly logger = new Logger(SignalGeneratorController.name);

  constructor(
    private readonly signalGeneratorService: SignalGeneratorService,
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly signalRepository: SignalRepository,
    private readonly universeScannerWorker: UniverseScannerWorker,
    private readonly setupTracker: SetupTrackerService,
    @InjectQueue('signal-scan') private readonly signalScanQueue: Queue,
    // Optional so unit tests / non-Chartink wirings still construct cleanly.
    // When wired (in app boot) every signal listing gets a chartinkSource
    // field — null unless a Chartink alert produced the matching setup.
    @Optional() private readonly chartinkRepo?: ChartinkRepository,
    // Optional for the same test-wiring reason. Backs the /zones endpoint
    // that the chart's ChartZoneOverlay polls every 60s.
    @Optional() private readonly zoneRepository?: ZoneRepository,
    // Compute-on-miss dependencies for /zones — when the cache is empty
    // we run the detector inline, persist, return. All optional so test
    // wirings still construct.
    @Optional() private readonly strongZoneDetector?: StrongZoneDetectorService,
    @Optional() private readonly levelBookService?: LevelBookService,
    @Optional() private readonly marketDataRepository?: MarketDataRepository,
    // Live 15m candle source for /zones — token-based, bypasses the duplicate
    // instrument rows that starve the DB-by-instrumentId path. Optional so
    // test wirings still construct.
    @Optional() private readonly angelOneAdapter?: AngelOneAdapterService,
    @Optional() private readonly srEvidenceService?: SrEvidenceService,
    // Subscription plan-gate for the chart/indicator DISPLAY reads below
    // (analyze/zones/indicators/sr-evidence). Optional so existing test wirings
    // still construct; when absent, non-ADMIN callers are denied (fail closed).
    @Optional() private readonly subs?: SubscriptionService,
    // Records live pattern detections into the ML training set from the
    // /patterns path — the only place live detections exist. Optional so test
    // wirings and non-ML containers still construct; when absent, detection
    // simply isn't captured and the overlay is unaffected.
    @Optional() private readonly patternCapture?: PatternCaptureService,
    // Composes /analyze + /zones + /sr-evidence for the charts page. Optional
    // for the same test-wiring reason as the rest; /chart-context is the only
    // route that needs it and constructs a plain instance if unwired.
    @Optional() private readonly chartContextService?: ChartContextService,
    // The per-user broker feed. /chart-context fetches its candles through the
    // SIGNED-IN USER's own Angel session, because this platform has no shared
    // feed account: every read that goes through `angelOneAdapter` on behalf of
    // a user throws `Not authenticated`. Optional so existing test wirings (and
    // any container without the per-user feed) still construct — when absent,
    // /chart-context falls back to exactly the shared-adapter path it used
    // before, which is the honest degradation, not a hidden one.
    @Optional() private readonly userFeedManager?: UserFeedManager,
  ) {}

  /**
   * A CandleSource bound to ONE user, or undefined when the per-user feed
   * isn't wired (tests / feed-disabled containers), in which case every
   * consumer keeps its pre-existing shared-adapter behaviour.
   *
   * Built per request rather than injected because the binding IS the user —
   * see candle-source.ts for why the shared adapter cannot serve these reads.
   */
  private candleSourceFor(userId: string | undefined): CandleSource | undefined {
    const manager = this.userFeedManager;
    if (!manager || !userId) return undefined;
    return {
      getCandles: (token, exchange, interval, from, to) =>
        manager.fetchCandles(userId, token, exchange, interval, from, to),
    };
  }

  /** The injected composer, or a local one so an unwired container still serves. */
  private get chartContext(): ChartContextService {
    if (!this.chartContextService) {
      this.fallbackChartContext ??= new ChartContextService();
      return this.fallbackChartContext;
    }
    return this.chartContextService;
  }
  private fallbackChartContext?: ChartContextService;

  /**
   * Chart/indicator display reads are open to ADMIN or any USER holding an
   * ACTIVE subscription (INTRADAY or SWING). Everything else on this controller
   * stays ADMIN-only via the class-level `@AdminOnly()`; these four reads
   * override that with `@Roles('USER','ADMIN')` and defer to this check.
   * Non-subscribed users get 403 {code:'NOT_SUBSCRIBED'}. Fails closed if the
   * SubscriptionService isn't wired.
   */
  private async assertChartAccess(user: AuthenticatedUser): Promise<void> {
    if (user?.role === 'ADMIN') return;
    const active = this.subs ? await this.subs.listForUser(user.userId) : null;
    if (!active || (!active.INTRADAY && !active.SWING)) {
      throw new ForbiddenException({ code: 'NOT_SUBSCRIBED' });
    }
  }

  /**
   * Enrich a signal with its `chartinkSource` if any. Looks up the
   * ChartinkAlertSetup row that points back at this signal — when no
   * Chartink alert produced this signal, returns null. Repo is optional
   * so this gracefully no-ops in test wirings.
   */
  private async enrichWithChartinkSource(signal: any): Promise<any> {
    if (!signal || typeof signal !== 'object') return signal;
    const chartinkSource = this.chartinkRepo
      ? await this.chartinkRepo.findChartinkSourceForSetup(signal.id)
      : null;
    return { ...signal, chartinkSource };
  }

  /**
   * GET /api/signals/setups/active — currently locked setup for a token.
   */
  @Get('setups/active')
  getActiveSetup(@Query('token') token: string) {
    if (!token) {
      throw new BadRequestException('token is required');
    }
    return { setup: this.setupTracker.getActive(token) };
  }

  /**
   * GET /api/signals/setups/history — recent closed setups for a token.
   */
  @Get('setups/history')
  getSetupHistory(@Query('token') token: string) {
    if (!token) {
      throw new BadRequestException('token is required');
    }
    return { history: this.setupTracker.getHistory(token) };
  }

  /**
   * Fetch live 15m candles via the Angel adapter (token-based, TTL-cached).
   * Token-based so it is immune to the duplicate-instrument-row problem that
   * starves the DB-by-instrumentId path. Returns [] when the adapter is
   * unwired or the fetch fails/throttles, so the caller can fall back to DB.
   *
   * `source` (optional) is the requesting user's own candle source — see
   * candle-source.ts. It is tried first and falls through to the shared
   * adapter, so an absent source leaves this byte-identical to before.
   */
  private async fetchLiveCandles(
    token: string,
    exchange: string,
    interval: string,
    from: Date,
    to: Date,
    source?: CandleSource,
  ): Promise<Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>> {
    if (source) {
      try {
        const rows = await source.getCandles(token, exchange, interval, from, to);
        if (Array.isArray(rows) && rows.length > 0) return rows.map(toOhlcvRow);
      } catch (err) {
        // WARN, not debug: the shared adapter below cannot authenticate for a
        // user request on this deployment, so if the per-user fetch is failing
        // the zone overlay is about to be empty for a reason nobody can see.
        this.warnOnce(
          `zones-user:${token}:${interval}`,
          `getZones: per-user candle fetch failed for ${token}/${interval} — falling back to the shared adapter: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (!this.angelOneAdapter) return [];
    try {
      const live = await this.angelOneAdapter.getHistoricalData(token, exchange, interval, from, to);
      return (live ?? []).map(toOhlcvRow);
    } catch (err) {
      this.logger.debug(
        `getZones: live candle fetch failed for ${token}: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }

  /** WARN once per key — a 60s poll must not turn an outage into a firehose. */
  private readonly warnedKeys = new Set<string>();
  private warnOnce(key: string, message: string): void {
    if (this.warnedKeys.has(key)) return;
    if (this.warnedKeys.size >= 1000) this.warnedKeys.clear();
    this.warnedKeys.add(key);
    this.logger.warn(message);
  }

  /**
   * GET /api/signals/zones — strong support/resistance zones for a token.
   *
   * Backs the chart's `ChartZoneOverlay` (top 5 above + 5 below LTP, with
   * STRONG/MEDIUM classification + flippedAt/wasType/preFlipTouchCount
   * metadata for swap zones).
   *
   * Two-tier read:
   *   1. DB cache (ZoneRepository) — fast path, refreshed by the detector
   *   2. Compute-on-miss — when cache is empty, run the detector inline
   *      using the level book + 200 most recent 15m candles, persist,
   *      and return. Means the chart overlay never sees an empty zone
   *      list just because the universe scan hasn't fired yet.
   *
   * Returns [] (not 404) when no zones can be computed (no level book,
   * insufficient candles, no detector wired) so the chart overlay
   * stays mounted and doesn't crash.
   */
  @Roles('USER', 'ADMIN')
  @Get('zones')
  async getZones(
    @CurrentUser() user: AuthenticatedUser,
    @Query('token') token: string,
    @Query('exchange') exchange?: string,
    @Query('symbol') symbol?: string,
    @Query('interval') interval?: string,
  ) {
    await this.assertChartAccess(user);
    if (!token) {
      throw new BadRequestException('token is required');
    }
    try {
      return await this.computeZones(token, exchange, symbol, interval);
    } catch (err) {
      this.logger.warn(
        `getZones: compute failed for ${token}: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }

  /**
   * The /zones body, minus the auth guard and minus the swallow-to-`[]`.
   *
   * Extracted so `/chart-context` can compose the same zone path without
   * re-running the subscription check three times per poll — and so it can see
   * a genuine failure as a failure. The HTTP route above keeps its existing
   * contract (never throws, returns []) for its current consumers.
   */
  private async computeZones(
    token: string,
    exchange?: string,
    symbol?: string,
    interval?: string,
    // Supplied only by /chart-context (the user-scoped path). The /zones route
    // passes nothing, so its behaviour is untouched.
    source?: CandleSource,
  ) {
    // Validate interval against the intraday set; anything else (1d, bogus,
    // omitted) collapses to the proven 15m path.
    const tf = isIntradayInterval(interval ?? '') ? interval! : '15m';
    const isFifteen = tf === '15m';

    // The 15m path is the only one allowed to touch the shared zone DB.
    // Non-15m (chart-only) computes in-memory and NEVER reads/writes it.
    if (isFifteen) {
      if (!this.zoneRepository) return [];

      // Cache hit — done.
      const cached = await this.zoneRepository.findActiveByToken(token);
      if (cached.length > 0) return cached;
    }

    // Cache miss (15m) or chart-only path (non-15m) — compute inline. All
    // deps optional so an unwired test container still returns []; production
    // has them.
    if (!this.strongZoneDetector || !this.levelBookService || !this.marketDataRepository) {
      return [];
    }

    let resolvedSymbol = symbol;
    let resolvedExchange = exchange;
    // Captured once here and reused by the DB-fallback candle fetch below, so
    // we don't look the instrument up twice on the rare fallback path.
    let resolvedInstrument:
      | Awaited<ReturnType<MarketDataRepository['getInstrumentByToken']>>
      | null = null;
    try {
      resolvedInstrument = await this.marketDataRepository.getInstrumentByToken(token);
      resolvedSymbol = resolvedSymbol ?? resolvedInstrument?.symbol;
      resolvedExchange = resolvedExchange ?? resolvedInstrument?.exchange ?? 'NSE';
    } catch (err) {
      this.logger.debug(
        `getZones: instrument lookup failed for ${token}: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (!resolvedSymbol || !resolvedExchange) return [];

    const book = await this.levelBookService.lazyLoad(token, resolvedExchange, resolvedSymbol);
    if (!book) return [];

    const now = new Date();
    const lookbackMs = lookbackDaysFor(tf) * 24 * 60 * 60 * 1000;
    const from = new Date(now.getTime() - lookbackMs);

    // Prefer LIVE candles at the selected interval (token-based) — robust to
    // duplicate instrument rows that split candle history and starve the
    // DB-by-instrumentId path. Fall back to the DB only when the live fetch
    // is unavailable (throttle / offline) so indices with seeded DB candles
    // still produce zones.
    let candles = await this.fetchLiveCandles(token, resolvedExchange, tf, from, now, source);
    if (candles.length < 10 && resolvedInstrument) {
      const rows = await this.marketDataRepository.getCandles(
        resolvedInstrument.id, tf, from, now, 200,
      );
      candles = rows.map((r) => ({
        timestamp: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: typeof r.volume === 'bigint' ? Number(r.volume) : r.volume,
      }));
    }

    if (candles.length < 10) return [];

    // 15m keeps the daily book ATR (frozen). Non-15m derives a per-TF ATR
    // from the selected-interval candles, falling back to the book ATR.
    const atr14 = isFifteen
      ? book.atr14
      : computeAtrFromCandles(candles, 14) || book.atr14;

    const zones = this.strongZoneDetector.detectZones({
      token,
      symbol: resolvedSymbol,
      exchange: resolvedExchange,
      candles15m: candles,
      levelBook: book,
      ltp: book.spot,
      atr14,
      interval: tf,
    });

    // Persist ONLY on the 15m path — the chart-only non-15m path must never
    // pollute the shared zone DB the scanner reads.
    if (isFifteen && this.zoneRepository) {
      try {
        await this.zoneRepository.upsertMany(token, zones);
      } catch (err) {
        this.logger.warn(
          `getZones: persist failed for ${token}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return zones;
  }

  /**
   * GET /api/signals/sr-evidence — evidence-weighted S/R levels (volume nodes,
   * adaptive round numbers, OI walls, pivot history) scored + sided vs spot.
   * Returns [] (not 404) when unavailable so the overlay stays mounted.
   */
  @Roles('USER', 'ADMIN')
  @Get('sr-evidence')
  async getSrEvidence(
    @CurrentUser() user: AuthenticatedUser,
    @Query('token') token: string,
    @Query('exchange') exchange?: string,
    @Query('symbol') symbol?: string,
    @Query('interval') interval?: string,
  ) {
    await this.assertChartAccess(user);
    if (!token) throw new BadRequestException('token is required');
    return this.computeSrEvidence(token, exchange, symbol, interval);
  }

  /**
   * The /sr-evidence body minus the auth guard, so /chart-context composes the
   * identical evidence path without re-checking the subscription.
   */
  private async computeSrEvidence(
    token: string,
    exchange?: string,
    symbol?: string,
    interval?: string,
    // See computeZones — only /chart-context supplies this.
    source?: CandleSource,
  ) {
    if (!this.srEvidenceService) return [];
    // Accept any supported timeframe — intraday (1m–1h) OR positional
    // (1d/1w/1mo) as its own path. `1M` (Yahoo-style monthly) is normalised to
    // `1mo`. Anything else (omitted/bogus) falls back to the proven 15m path.
    const norm = normalizeInterval(interval ?? '');
    const tf = isSupportedInterval(norm) ? norm : '15m';
    let resolvedSymbol = symbol;
    let resolvedExchange = exchange ?? 'NSE';
    if (!resolvedSymbol && this.marketDataRepository) {
      try {
        const inst = await this.marketDataRepository.getInstrumentByToken(token);
        resolvedSymbol = inst?.symbol;
        resolvedExchange = inst?.exchange ?? resolvedExchange;
      } catch {
        /* fall through — service handles missing symbol */
      }
    }
    // Only pass the 5th argument when there is one: the /sr-evidence route
    // supplies no source and must keep calling levelsFor exactly as it did.
    return source
      ? this.srEvidenceService.levelsFor(token, resolvedExchange, resolvedSymbol ?? '', tf, source)
      : this.srEvidenceService.levelsFor(token, resolvedExchange, resolvedSymbol ?? '', tf);
  }

  /**
   * The trend source of /chart-context: a least-squares line through the swing
   * pivots of the SAME per-timeframe candles SrEvidenceService scores its
   * levels from, so the line and the levels can never be derived from
   * different data. No extra broker call in the normal case — the adapter's
   * TTL historical cache serves the repeat fetch.
   *
   * Returns null ("no clear trend") when the series is unavailable or nothing
   * fits; only a genuine throw propagates, which is what marks the source
   * 'failed' rather than 'empty'.
   */
  private async computeTrend(
    candles: () => Promise<ChartCandle[]>,
  ): Promise<TrendLine | null> {
    const series = (await candles())
      .filter((c) => Number.isFinite(c.time))
      .map((c) => ({ time: c.time as number, high: c.high, low: c.low }));
    return fitTrendLine(series);
  }

  /**
   * The candle series /chart-context's trend and trade plan both read.
   *
   * Memoised by the caller so the two share ONE fetch, and so the plan's
   * fallback spot is by construction the last bar of the very series the trend
   * was fitted on — the chart cannot be drawing a line from one dataset and a
   * level from another.
   */
  private async chartCandles(
    token: string,
    exchange: string,
    symbol: string | undefined,
    interval: string,
    source?: CandleSource,
  ): Promise<ChartCandle[]> {
    if (!this.srEvidenceService) return [];
    let resolvedSymbol = symbol;
    // Only the Yahoo (1w/1mo) branch needs a symbol; resolve it the same way
    // computeSrEvidence does, and let a lookup failure fall through rather
    // than fail the whole source.
    if (!resolvedSymbol && this.marketDataRepository) {
      try {
        resolvedSymbol = (await this.marketDataRepository.getInstrumentByToken(token))?.symbol;
      } catch {
        /* fall through — the intraday/daily branch doesn't need it */
      }
    }
    const candles = await this.srEvidenceService.candlesFor(
      token,
      exchange,
      resolvedSymbol ?? '',
      interval,
      source,
    );
    return Array.isArray(candles) ? candles : [];
  }

  /**
   * The trade plan — composed, never fetched.
   *
   * Every input here has already been paid for by another loader: the analysis
   * promise is the memoised /analyze call, the evidence promise is the memoised
   * S/R evidence read, and the level book is an in-memory read of the book that
   * same analyze() call populated (spot, plus the round numbers and vol strikes
   * `LevelsSnapshot` doesn't carry). Supplying those keeps the pending
   * candidate set IDENTICAL to the one the live strategy scans.
   *
   * Evidence is allowed to fail on its own without taking the plan with it — it
   * only annotates the reason sentence. A failed ANALYSIS does propagate: with
   * no levels and no spot there is no plan, and "we don't know" is the honest
   * answer rather than an empty one.
   */
  private async composeTradePlan(
    token: string,
    analysis: () => Promise<Awaited<ReturnType<SignalGeneratorService['analyze']>> | null>,
    evidence: () => Promise<Array<{ price: number; score: number }>>,
    candles: () => Promise<ChartCandle[]>,
  ): Promise<TradePlan> {
    const result = await analysis();
    const evidenceLevels = await evidence().catch(() => []);
    // In-memory read of the book analyze() just refreshed — no broker call.
    const book = this.levelBookService?.getLevels?.(token) ?? null;
    const levels = result?.levels ?? null;
    return buildTradePlan({
      analysis: result,
      levels,
      evidence: evidenceLevels as never,
      // `book.spot` is written ONLY by updateFromTick and seeded to 0, so it is
      // a real price only once a tick has landed. Before the first tick of a
      // session — overnight, weekends, or any symbol this user has no live
      // subscription to — it stays 0, and anchoring the plan on it produced an
      // all-null plan reported as 'empty'. That read as "no level qualifies"
      // when the truth was "the scan never ran", which is the exact empty-vs-
      // failed conflation this endpoint exists to prevent.
      //
      // The last close of the chart's own candle series is a real price
      // whenever the chart has bars to draw, so the plan is anchored on
      // whichever of the two is genuinely a price, live tick preferred.
      ltp: firstPrice(book?.spot, lastClose(await candles().catch(() => []))),
      atr14: levels?.atr14 ?? book?.atr14 ?? null,
      roundNumbers: book?.roundNumbers,
      volStrikes: book?.topVolStrikes,
    });
  }

  /**
   * The projection boxes — composed, never fetched.
   *
   * Every input is already paid for: the memoised analysis, evidence and zone
   * promises, plus the level book's in-memory spot. The geometry itself is
   * pure (see zone-projection.ts).
   *
   * Higher-timeframe zones are read from the zone CACHE only. Detecting them
   * live would mean a second candle series at another timeframe — a chunked,
   * rate-limited broker fetch on the queue the chart's own candles share, which
   * is exactly the regression 49d1fc1 fixed. When the cache has nothing, the
   * HTF is reported as NOT CONSULTED rather than as clear: `htfZones`
   * undefined makes the builder say so in its reason instead of silently
   * drawing an uncapped projection.
   */
  private async composeProjections(
    timeframe: string,
    token: string,
    exchange: string,
    analysis: () => Promise<Awaited<ReturnType<SignalGeneratorService['analyze']>> | null>,
    evidence: () => Promise<Array<{ price: number; score: number }>>,
    zones: () => Promise<StrongZone[]>,
    candles: () => Promise<ChartCandle[]>,
  ): Promise<ProjectionZones> {
    const result = await analysis();
    const [evidenceLevels, chartZones] = await Promise.all([
      evidence().catch(() => []),
      zones().catch(() => []),
    ]);
    const book = this.levelBookService?.getLevels?.(token) ?? null;
    const levels = result?.levels ?? null;

    const htf = HTF_FOR_TIMEFRAME[timeframe] ?? null;
    const htfZones = htf ? await this.cachedZonesFor(token, htf) : undefined;

    return buildProjectionZones({
      timeframe,
      ltp: firstPrice(book?.spot, lastClose(await candles().catch(() => []))),
      atr14: levels?.atr14 ?? book?.atr14 ?? null,
      zones: chartZones,
      htfZones,
      evidence: evidenceLevels as never,
      levels,
      // The clock is injected so the geometry stays pure and its session-cap
      // behaviour is testable without freezing time.
      now: new Date(),
      exchange,
      // The level book's ATR is seeded from DAILY candles, which is what the
      // session budget needs — it asks how much of a typical DAY's range is
      // left. `levels.atr14` is the CHART timeframe's and would cap every
      // projection to a few points.
      dailyAtr: book?.atr14 ?? null,
    });
  }

  /**
   * Higher-timeframe zones from the persisted zone cache, or undefined when we
   * have none — "not consulted", which the projection builder distinguishes
   * from "consulted and clear". Never computes, never fetches.
   */
  private async cachedZonesFor(token: string, timeframe: string): Promise<StrongZone[] | undefined> {
    if (!this.zoneRepository) return undefined;
    try {
      const cached = await this.zoneRepository.findActiveByToken(token);
      if (!Array.isArray(cached) || cached.length === 0) return undefined;
      // The 15m zone table is the only persisted one; treat it as the HTF view
      // only when the chart is BELOW it, never as a peer of itself.
      return timeframe === '15m' ? cached : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * GET /api/signals/chart-context — the charts page's single S/R read.
   *
   * Composes the three sources the page used to poll separately (/analyze's
   * level book, /zones, /sr-evidence) behind one 60s cache and one status.
   * Each source is resolved independently: one of them failing degrades that
   * source and nothing else. This route NEVER throws to the client for a
   * source failure — all-failed is HTTP 200 with status 'unavailable', because
   * the chart has to render that state rather than catch an exception.
   *
   * The only 4xx is an unsupported `interval`, which is a caller bug: the
   * toolbar renders CHART_TIMEFRAMES, a subset of the engine's roster.
   */
  @Roles('USER', 'ADMIN')
  @Get('chart-context')
  async getChartContext(
    @CurrentUser() user: AuthenticatedUser,
    @Query('token') token: string,
    @Query('exchange') exchange?: string,
    @Query('interval') interval?: string,
    @Query('symbol') symbol?: string,
  ): Promise<ChartContextDto> {
    await this.assertChartAccess(user);
    if (!token) throw new BadRequestException('token is required');

    // Omitted interval keeps the proven 15m default (every other chart read
    // does the same); a value that was actually supplied must be analysable.
    const tf = interval ? normalizeInterval(interval) : '15m';
    if (!isSupportedInterval(tf)) {
      throw new BadRequestException(`unsupported interval: ${interval}`);
    }

    const resolvedExchange = exchange ?? 'NSE';
    // Every candle these four sources read comes from THIS user's own Angel
    // session. Before this, all four went through the shared adapter, which has
    // no feed account to log in with — so the S/R engine returned [] for every
    // symbol and timeframe, permanently, and the chart faithfully reported "no
    // levels in range". See candle-source.ts.
    const source = this.candleSourceFor(user?.userId);
    // /analyze needs a symbol; the chart only knows the token. Resolved once
    // here and handed to the analysis loader — a lookup failure is that
    // loader's failure, not the whole response's.
    //
    // Returns the WHOLE analyze result, not just `.levels`. It used to discard
    // everything else, which left the chart polling /analyze separately for the
    // setup payload — two endpoints and two cadences over one computation, free
    // to disagree mid-poll. Keeping the whole result costs nothing.
    const analysisLoader = async () => {
      let resolvedSymbol = symbol;
      if (!resolvedSymbol && this.marketDataRepository) {
        const inst = await this.marketDataRepository.getInstrumentByToken(token);
        resolvedSymbol = inst?.symbol;
      }
      if (!resolvedSymbol) return null;
      // The anchored lines (PDH/PDL/ORH/ORL/VWAP) are what a user most expects
      // to see on the chart, so this loader gets the per-user source too — the
      // level book's daily statics come from a broker fetch like everything
      // else here.
      return this.signalGeneratorService.analyze(
        token,
        resolvedExchange,
        resolvedSymbol,
        tf,
        source,
      );
    };

    // Memoised so the trade-plan loader can COMPOSE from these two rather than
    // re-fetch them. Both run at most once per request; the plan adds no broker
    // call of its own, which is the whole reason it rides this endpoint instead
    // of being one.
    let analysisOnce: ReturnType<typeof analysisLoader> | undefined;
    const analysis = () => (analysisOnce ??= analysisLoader());
    let evidenceOnce: Promise<Awaited<ReturnType<typeof this.computeSrEvidence>>> | undefined;
    const evidence = () =>
      (evidenceOnce ??= this.computeSrEvidence(token, resolvedExchange, symbol, tf, source));
    // Shared by the trend fit and the plan's fallback spot — one fetch, and by
    // construction the same bars behind both.
    let candlesOnce: Promise<ChartCandle[]> | undefined;
    const candles = () =>
      (candlesOnce ??= this.chartCandles(token, resolvedExchange, symbol, tf, source));
    // Memoised for the same reason: the projection geometry needs the very
    // zones the response reports, not a second detection pass that could
    // disagree with the one the chart is drawing.
    let zonesOnce: Promise<Awaited<ReturnType<typeof this.computeZones>>> | undefined;
    const zones = () =>
      (zonesOnce ??= this.computeZones(token, resolvedExchange, symbol, tf, source));

    return this.chartContext.build(
      { token, exchange: resolvedExchange, interval: tf },
      {
        analysis,
        zones,
        evidence,
        trend: () => this.computeTrend(candles),
        tradePlan: () => this.composeTradePlan(token, analysis, evidence, candles),
        projections: () => this.composeProjections(tf, token, resolvedExchange, analysis, evidence, zones, candles),
      },
    );
  }

  /**
   * POST /api/signals/scan-now — manually trigger one universe scan tick.
   * Bypasses the 15-min cron so we can smoke-test the combined-strategy
   * pipeline immediately. Returns the per-symbol outcome.
   */
  @Post('scan-now')
  @HttpCode(HttpStatus.OK)
  async scanNow() {
    return this.universeScannerWorker.runOnce();
  }

  /**
   * POST /api/signals/reset-transition — clear the combined strategy's
   * transition memory so it can re-fire even if the conditions are still
   * aligned. Use this to unstick the strategy after a downstream failure
   * left it thinking a trade was already placed when it wasn't.
   */
  @Post('reset-transition')
  @HttpCode(HttpStatus.OK)
  async resetTransition() {
    const strat = this.strategyRegistry.getStrategy('anand-sniper-v25-combined') as
      | { resetTransition?: () => void }
      | undefined;
    if (strat && typeof strat.resetTransition === 'function') {
      strat.resetTransition();
      return { ok: true, reset: 'anand-sniper-v25-combined' };
    }
    return { ok: false, reason: 'strategy not found or does not support reset' };
  }

  /**
   * GET /api/signals — list signals with filters and pagination.
   */
  @Get()
  async listSignals(@Query() filters: SignalFilterDto) {
    const result = await this.signalGeneratorService.getSignalHistory(filters);
    return {
      ...result,
      data: Array.isArray(result.data)
        ? await Promise.all(result.data.map((s) => this.enrichWithChartinkSource(s)))
        : result.data,
    };
  }

  /**
   * GET /api/signals/active — currently active signals.
   *
   * `?recentHours=N` also returns signals that expired within the last
   * N hours. The Signals page uses N=12 so traders can see the day's
   * earlier signals after their session-end TTL has flipped them to
   * inactive.
   */
  @Get('active')
  async getActiveSignals(@Query('recentHours') recentHours?: string) {
    const hours = recentHours ? Number(recentHours) : 0;
    const signals = await this.signalGeneratorService.getActiveSignals(
      Number.isFinite(hours) && hours > 0 ? hours : 0,
    );
    return Array.isArray(signals)
      ? Promise.all(signals.map((s) => this.enrichWithChartinkSource(s)))
      : signals;
  }

  /**
   * GET /api/signals/strategies — list all registered strategies with metadata.
   */
  @Get('strategies')
  async listStrategies() {
    return this.strategyRegistry.getAllStrategies();
  }

  @Roles('USER', 'ADMIN')
  @Get('analyze')
  async analyzeChart(
    @CurrentUser() user: AuthenticatedUser,
    @Query('token') token: string,
    @Query('exchange') exchange: string,
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe?: string,
  ) {
    await this.assertChartAccess(user);
    if (!token || !exchange || !symbol) {
      throw new BadRequestException('token, exchange, symbol are required');
    }
    try {
      return await this.signalGeneratorService.analyze(
        token,
        exchange,
        symbol,
        timeframe ?? '15m',
      );
    } catch (err) {
      this.logger.error(
        `analyze failed for ${symbol}/${timeframe ?? '15m'}: ${err instanceof Error ? err.stack ?? err.message : err}`,
      );
      throw err;
    }
  }

  /**
   * GET /api/signals/patterns — detected candlestick + chart patterns for a
   * token / timeframe. Backs the chart's pattern-marker overlay. Returns an
   * empty pattern list (not 404) whenever there aren't enough candles to detect
   * anything, so the overlay stays mounted.
   */
  @Roles('USER', 'ADMIN')
  @Get('patterns')
  async getPatterns(
    @CurrentUser() user: AuthenticatedUser,
    @Query('token') token: string,
    @Query('exchange') exchange?: string,
    @Query('timeframe') timeframe?: string,
  ): Promise<PatternsResponseDto> {
    await this.assertChartAccess(user);
    if (!token) {
      throw new BadRequestException('token is required');
    }
    return this.detectPatterns(token, exchange, timeframe);
  }

  /**
   * Fetch candles for `token` at `timeframe` and run the pattern detectors,
   * returning the flat wire shape. Lookback widens for positional timeframes so
   * the swing/chart detectors see enough bars. Returns an empty list (never
   * throws) when the fetch throttles or yields too few candles.
   */
  private async detectPatterns(
    token: string,
    exchange?: string,
    timeframe?: string,
  ): Promise<PatternsResponseDto> {
    const tf = timeframe ?? '15m';
    let resolvedSymbol = token;
    let resolvedExchange = exchange ?? 'NSE';
    if (this.marketDataRepository) {
      try {
        const inst = await this.marketDataRepository.getInstrumentByToken(token);
        resolvedSymbol = inst?.symbol ?? resolvedSymbol;
        resolvedExchange = inst?.exchange ?? resolvedExchange;
      } catch (err) {
        this.logger.debug(
          `getPatterns: instrument lookup failed for ${token}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Intraday (contains 'm' or 'h') needs ~15 days of bars; daily/weekly
    // ('d'/'w') need a much longer window for the swing detector to find pivots.
    const lower = tf.toLowerCase();
    const isPositional = lower.includes('d') || lower.includes('w');
    const now = new Date();
    const lookbackDays = isPositional ? 300 : 15;
    const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    let raw: Awaited<ReturnType<AngelOneAdapterService['getHistoricalData']>> = [];
    if (this.angelOneAdapter) {
      try {
        raw = await this.angelOneAdapter.getHistoricalData(
          token,
          resolvedExchange,
          tf,
          from,
          now,
          'interactive',
        );
      } catch (err) {
        this.logger.debug(
          `getPatterns: candle fetch failed for ${token}: ${err instanceof Error ? err.message : err}`,
        );
        raw = [];
      }
    }

    // Typed OhlcvCandle (not Candle) so this one array serves both consumers:
    // the detectors need `Candle`, which OhlcvCandle structurally satisfies, and
    // the ML assembler additionally needs `volume`. Mapping once means the
    // detected patterns and the captured feature window can never disagree.
    const candles: OhlcvCandle[] = (raw ?? []).map((c) => ({
      time: c.timestamp.getTime(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: Number(c.volume ?? 0),
    }));

    if (candles.length < 25) {
      return { symbol: resolvedSymbol, timeframe: tf, count: 0, patterns: [] };
    }

    const patterns = buildPatternMarkers(candles);

    // Record the live detection for the ML pattern-quality training set. This is
    // the ONLY path live detections are captured from — backfill covers history,
    // nothing else covers now.
    //
    // Detached on purpose. This is a chart-overlay read on the <500ms market-data
    // path, and a training-data write has no business sitting in front of the
    // user's chart. `capture` is fail-open internally (returns 0, never throws);
    // the .catch() guards the detached promise regardless, since an unhandled
    // rejection can take the process down. Duplicate loads are harmless — the
    // repo writes with skipDuplicates against the row's unique key.
    if (this.patternCapture) {
      void this.patternCapture
        .capture(candles, patterns, { token, exchange: resolvedExchange, timeframe: tf })
        .catch((err) =>
          this.logger.debug(
            `pattern capture failed for ${token}: ${err instanceof Error ? err.message : err}`,
          ),
        );
    }

    return { symbol: resolvedSymbol, timeframe: tf, count: patterns.length, patterns };
  }

  /**
   * GET /api/signals/indicators — standalone IndicatorReadings for a
   * token / timeframe, independent of any active setup. Backs the
   * StockOverviewPanel's IndicatorsCard. Returns `{ indicators: null }`
   * when there aren't enough candles; the frontend renders 'unavailable'.
   */
  @Roles('USER', 'ADMIN')
  @Get('indicators')
  async getIndicators(
    @CurrentUser() user: AuthenticatedUser,
    @Query('token') token: string,
    @Query('exchange') exchange: string,
    @Query('timeframe') timeframe: string,
  ) {
    await this.assertChartAccess(user);
    if (!token || !exchange || !timeframe) {
      throw new BadRequestException('token, exchange, timeframe are required');
    }
    try {
      const indicators = await this.signalGeneratorService.computeIndicatorsFor(
        token,
        exchange,
        timeframe,
      );
      return { indicators };
    } catch (err) {
      this.logger.error(
        `computeIndicatorsFor failed for ${token}/${timeframe}: ${err instanceof Error ? err.stack ?? err.message : err}`,
      );
      throw err;
    }
  }

  /**
   * GET /api/signals/strategies/:name/performance — strategy performance stats.
   */
  @Get('strategies/:name/performance')
  async getStrategyPerformance(
    @Param('name') name: string,
    @Query('days') days?: string,
  ) {
    const lookbackDays = days ? parseInt(days, 10) : 30;
    const fromDate = new Date(
      Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
    );
    return this.signalRepository.getStrategyPerformance(name, fromDate);
  }

  /**
   * GET /api/signals/:id — single signal detail.
   */
  @Get(':id')
  async getSignalById(@Param('id') id: string) {
    const signal = await this.signalRepository.getSignalById(id);
    if (!signal) {
      throw new NotFoundException(`Signal ${id} not found`);
    }
    return this.enrichWithChartinkSource(signal);
  }

  /**
   * POST /api/signals/scan — trigger a manual scan (for testing/admin).
   */
  @Post('scan')
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerScan() {
    this.logger.log('Manual signal scan triggered');

    await this.signalScanQueue.add(
      { scanAll: true },
      {
        removeOnComplete: true,
        removeOnFail: 10,
        attempts: 1,
      },
    );

    return { message: 'Signal scan queued', status: 'accepted' };
  }

  /**
   * DELETE /api/signals/:id — deactivate a signal.
   */
  @Delete(':id')
  async deactivateSignal(@Param('id') id: string) {
    const signal = await this.signalRepository.getSignalById(id);
    if (!signal) {
      throw new NotFoundException(`Signal ${id} not found`);
    }

    return this.signalGeneratorService.deactivateSignal(id);
  }
}
