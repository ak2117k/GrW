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
  ServiceUnavailableException,
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
import { LevelBookService } from '../services/level-book.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { SrEvidenceService } from '../services/sr-evidence.service';
import { isIntradayInterval, isSupportedInterval, normalizeInterval, lookbackDaysFor } from '../services/timeframe-lookback';
import { computeAtrFromCandles } from '../services/per-tf-atr';
import { AdminOnly, Roles, CurrentUser, AuthenticatedUser } from '../../../common/decorators';
import { SubscriptionService } from '../../subscription/subscription.service';
import type { Candle } from '../patterns/swing-points';
import { buildPatternMarkers } from '../patterns/to-markers';
import { PatternsResponseDto } from '../dto/pattern-marker.dto';
import { PatternBackfillService, type BackfillTarget } from '../ml/pattern-backfill.service';
import { PatternCaptureService } from '../ml/pattern-capture.service';

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
    // ML pattern-quality data capture, driven by the /ml/* ops triggers below.
    // Optional for the same test-wiring reason; the triggers 503 when unwired.
    @Optional() private readonly patternBackfill?: PatternBackfillService,
    @Optional() private readonly patternCapture?: PatternCaptureService,
  ) {}

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
   */
  private async fetchLiveCandles(
    token: string,
    exchange: string,
    interval: string,
    from: Date,
    to: Date,
  ): Promise<Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>> {
    if (!this.angelOneAdapter) return [];
    try {
      const live = await this.angelOneAdapter.getHistoricalData(token, exchange, interval, from, to);
      return (live ?? []).map((c: any) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: Number(c.volume),
      }));
    } catch (err) {
      this.logger.debug(
        `getZones: live candle fetch failed for ${token}: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
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

    try {
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
      let candles = await this.fetchLiveCandles(token, resolvedExchange, tf, from, now);
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
    } catch (err) {
      this.logger.warn(
        `getZones: compute failed for ${token}: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
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
    return this.srEvidenceService.levelsFor(token, resolvedExchange, resolvedSymbol ?? '', tf);
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
   * POST /api/signals/ml/backfill/trigger
   *
   * Replay history for the given instruments, detect patterns, and persist the
   * labeled observations that train the ML pattern-quality scorer.
   *
   * ASYNCHRONOUS: returns 202 immediately and runs the pass detached. One pass
   * is ~527 serialized broker calls behind a 350ms gate (~5-7 min) because
   * sub-hour timeframes auto-chunk at 1 day each — far past the ~30-60s timeout
   * of the external heartbeats that drive this. Awaiting it meant the caller
   * ALWAYS timed out while the work continued server-side, and the next
   * heartbeat piled another run on top. Per-(target × timeframe) results go to
   * the logger, so a detached run stays observable.
   *
   * If a pass is already in flight this returns {accepted:false} rather than
   * starting or queueing a second one (the guard itself lives in the service).
   *
   * ADMIN-only (class-level @AdminOnly): this is an ops action that burns Angel
   * One history quota and writes to the shared training set.
   *
   * Invoked by an external heartbeat (cron-job.org / UptimeRobot) rather than an
   * in-process @Cron — the free tier spins the service down when idle, so a
   * fixed-time in-process scheduler would simply never fire.
   *
   * Body:
   *   { targets: [{token, exchange, symbol}], timeframes?: string[], lookbackDays?: number }
   *
   *   targets:     required, non-empty. Explicit by design — there is no
   *                instrument-universe lookup here.
   *   timeframes:  restrict the replay (e.g. ["15m"]). Default: all of
   *                BACKFILL_TIMEFRAMES.
   *   lookbackDays: override the per-timeframe default window.
   */
  @Post('ml/backfill/trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  // Deliberately `async` while never awaiting `run()`: the handler still
  // returns on its first tick (that IS the fix), but the validation throws
  // above surface as rejections rather than synchronous throws.
  async triggerPatternBackfill(
    @Body() body: { targets?: BackfillTarget[]; timeframes?: string[]; lookbackDays?: number } = {},
  ) {
    if (!this.patternBackfill) {
      throw new ServiceUnavailableException('pattern backfill is not wired');
    }
    const targets = body.targets ?? [];
    if (targets.length === 0) {
      throw new BadRequestException('targets is required and must be non-empty');
    }
    for (const t of targets) {
      if (!t?.token || !t?.exchange || !t?.symbol) {
        throw new BadRequestException('each target needs token, exchange and symbol');
      }
    }
    // Report the refusal rather than silently no-op'ing. Checked before the
    // call (not from run()'s return) because the run is detached — its result
    // is never seen here. Race-free: run() flips the flag synchronously.
    if (this.patternBackfill.isRunning) {
      return {
        accepted: false,
        reason: 'a pattern backfill run is already in progress',
      };
    }
    // Fire-and-forget. The .catch() is REQUIRED: an unhandled rejection from a
    // detached promise can take the Node process down.
    void this.patternBackfill
      .run(targets, { timeframes: body.timeframes, lookbackDays: body.lookbackDays })
      .catch((err) =>
        this.logger.error(
          `pattern backfill run failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
    return { accepted: true, targets: targets.length };
  }

  /**
   * POST /api/signals/ml/resolve-pending/trigger
   *
   * Finalize observations whose follow-through horizon has since completed:
   * re-fetches their bars, recomputes the outcome, and stamps WIN/LOSS/TIMEOUT.
   * Rows still inside their horizon are left PENDING for a later run.
   *
   * ADMIN-only (class-level @AdminOnly) and external-heartbeat driven, for the
   * same reasons as the backfill trigger above.
   *
   * Body (all optional):
   *   { limit?: number }  — max PENDING rows to attempt. Default 200.
   */
  @Post('ml/resolve-pending/trigger')
  @HttpCode(HttpStatus.OK)
  async triggerResolvePending(@Body() body: { limit?: number } = {}) {
    if (!this.patternCapture) {
      throw new ServiceUnavailableException('pattern capture is not wired');
    }
    const resolved = await this.patternCapture.resolvePending(body.limit);
    return { ok: true, resolved };
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

    const candles: Candle[] = (raw ?? []).map((c) => ({
      time: c.timestamp.getTime(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    if (candles.length < 25) {
      return { symbol: resolvedSymbol, timeframe: tf, count: 0, patterns: [] };
    }

    const patterns = buildPatternMarkers(candles);
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
