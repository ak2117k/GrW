import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  MarketSnapshot,
  SignalOutput,
} from '../../../common/interfaces/trading-strategy.interface';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { SettingsService } from '../../settings/services/settings.service';
import { StrategyRegistryService } from './strategy-registry.service';
import { SignalScoringService } from './signal-scoring.service';
import { SignalRepository, CreateSignalInput } from '../repositories/signal.repository';
import { ZoneRepository } from '../repositories/zone.repository';
import { SignalGateway } from '../gateways/signal.gateway';
import { SignalFilterDto } from '../dto/signal.dto';
import { LevelBookService } from './level-book.service';
import {
  SetupTrackerService,
  SetupStatus,
  LockedSetup,
  RecommendedStrike,
} from './setup-tracker.service';
import { OptionStrikeSelectorService } from '../../options-chain/services/option-strike-selector.service';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { ContextScoringService } from './context-scoring/context-scoring.service';
import type { ContextFactorBreakdown } from '../types/setup-context.types';
import { LevelsContextStrategy, classifyRegime, buildIndicatorReadings } from '../strategies/levels-context.strategy';
import { ema } from '../strategies/indicators';
import { SetupContext, IndicatorReadings } from '../types/setup-context.types';
import { LevelBook } from '../types/level-book.types';
import { computeExpiry } from '../utils/compute-expiry';
import {
  TIMEFRAMES,
  MARKET_OPEN_HOUR,
  MARKET_OPEN_MINUTE,
  MARKET_CLOSE_HOUR,
  MARKET_CLOSE_MINUTE,
  MCX_OPEN_HOUR,
  MCX_OPEN_MINUTE,
  MCX_CLOSE_HOUR,
  MCX_CLOSE_MINUTE,
} from '@td/shared/constants';
import { Exchange } from '@td/shared/types';

/** Minimum number of timeframes that must agree for signal confirmation. */
const MIN_TIMEFRAME_AGREEMENT = 2;

/**
 * How long a per-token broker daily-statics refresh stays "fresh" before
 * `analyze()` will trigger another one. Matches LevelBookService's
 * LAZY_FRESH_MS (5 min) so the two freshness windows stay aligned.
 *
 * PERF: `analyze()` is polled ~every 60s by the chart's Setup card. Before
 * this gate every poll called `levelBookService.refreshFromBroker`, which
 * issues a fresh Angel `getHistoricalData('1d', …)` REST call — re-hitting
 * the broker every minute for daily statics (PDH/PDL/prevClose/atr14) that
 * only change once per session. Gating the refresh to once per
 * REFRESH_FROM_BROKER_FRESH_MS removes that redundant per-poll fetch.
 */
const REFRESH_FROM_BROKER_FRESH_MS = 5 * 60 * 1000;

/**
 * Map a working timeframe to the next-higher timeframe used for the MTF
 * trend filter. Daily has no higher TF — null short-circuits the check.
 */
const HIGHER_TF_MAP: Record<string, string | null> = {
  '1m': '5m',
  '5m': '15m',
  '15m': '1h',
  '1h': '4h',
  '4h': '1d',
  '1d': null,
};

/** Number of higher-TF candles to fetch for the EMA9/EMA21 computation. */
const HIGHER_TF_CANDLE_TARGET = 30;

/**
 * Look-back window when fetching higher-TF candles. Generous because the
 * higher TF spans larger chunks of time per bar — 30 daily candles = 30
 * trading days, 30 hourly candles = ~5 trading days.
 */
const HIGHER_TF_LOOKBACK_DAYS = 60;

/**
 * Standard option lot sizes by underlying. The `instrument` table's lotSize
 * for an INDICES row reflects the index unit, not the F&O lot — so we keep
 * a small canonical map here. Stocks fall back to 1, which means the
 * frontend will render per-share P&L instead of per-lot.
 */
const OPTION_LOT_SIZES: Record<string, number> = {
  NIFTY: 75,
  BANKNIFTY: 15,
  FINNIFTY: 40,
  MIDCPNIFTY: 75,
  SENSEX: 10,
  CRUDEOIL: 100,
  COPPER: 2500,
  GOLD: 100,
  SILVER: 30,
  NATURALGAS: 1250,
};

function resolveOptionLotSize(symbol: string): number {
  return OPTION_LOT_SIZES[symbol.toUpperCase()] ?? 1;
}

export { RecommendedStrike } from './setup-tracker.service';

export interface LevelsSnapshot {
  pdh: number;
  pdl: number;
  orh: number | null;
  orl: number | null;
  /**
   * Previous trading day's opening range. Surfaced so the chart can render
   * dimmed `Y-ORH` / `Y-ORL` lines as a fallback when today's OR hasn't
   * locked yet (pre-9:30 IST). null when prior-day data isn't available.
   */
  prevOrh: number | null;
  prevOrl: number | null;
  vwap: number;
  todayHigh: number;
  todayLow: number;
  atr14: number;
}

export type AnalyzeResult =
  | {
      kind: 'setup';
      symbol: string;
      side: 'BUY' | 'SELL';
      entry: number;
      stoploss: number;
      target: number;
      partialTakeAt: number;
      trailingSl: number | null;
      levelType: SetupContext['levelType'];
      setupType: SetupContext['setupType'];
      grade: SetupContext['grade'];
      atr14: number;
      volumeRatio: number;
      levels: LevelsSnapshot;
      reason: string;
      indicators: SetupContext['indicators'];
      higherTimeframeTrend: SetupContext['higherTimeframeTrend'];
      regime: SetupContext['regime'];
      intradayRangeRatio: number;
      status: SetupStatus;
      setupId: string;
      triggeredAt: string | null;
      partialBookedAt: string | null;
      recommendedStrike: RecommendedStrike | null;
      /**
       * Adaptive-invalidation classification + reason. Populated when the
       * setup was closed early via one of the three short-circuit paths
       * (structural / counter-setup / time-mfe). Both fields stay null on
       * still-open setups and on plain target/SL/EOD closes.
       */
      invalidationKind?: 'structural' | 'counter-setup' | 'time-mfe' | null;
      invalidationReason?: string | null;
      /**
       * Source of the TP1 placement and metadata about the obstacle that
       * drove it (when 'obstacle'). Surfaces in the AnalysisPanel TP1 row
       * as a small subtitle so the trader sees WHY TP1 sits where it does.
       */
      tp1Source?: 'obstacle' | 'fixed';
      tp1Obstacle?: {
        classification: 'STRONG' | 'MEDIUM';
        touchCount: number;
        nearEdge: number;
      } | null;
      /**
       * Context-scoring engine (Mama's 10-factor framework). Optional so
       * pre-scoring code paths and persisted-only setups still serialise
       * cleanly. See `ContextScoringService.score`.
       */
      contextScore?: number;
      contextTier?: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
      contextCoverage?: number;
      contextFactors?: ContextFactorBreakdown[];
    }
  | {
      kind: 'no-setup';
      reason: string;
      levels: LevelsSnapshot | null;
      higherTimeframeTrend: SetupContext['higherTimeframeTrend'];
      regime: SetupContext['regime'];
      intradayRangeRatio: number;
    };

function snapshotFromBook(book: LevelBook): LevelsSnapshot {
  return {
    pdh: book.pdh,
    pdl: book.pdl,
    orh: book.orh,
    orl: book.orl,
    prevOrh: book.prevOrh,
    prevOrl: book.prevOrl,
    vwap: book.vwap,
    todayHigh: book.todayHigh,
    todayLow: book.todayLow,
    atr14: book.atr14,
  };
}

@Injectable()
export class SignalGeneratorService {
  private readonly logger = new Logger(SignalGeneratorService.name);

  /**
   * Per-token timestamp (epoch ms) of the last `refreshFromBroker` call made
   * from `analyze()`. Used to gate the per-poll daily-statics broker fetch
   * behind REFRESH_FROM_BROKER_FRESH_MS (see that constant).
   */
  private readonly lastBrokerRefreshAt = new Map<string, number>();

  constructor(
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly signalScoring: SignalScoringService,
    private readonly signalRepository: SignalRepository,
    private readonly marketFeedService: MarketFeedService,
    private readonly marketDataRepository: MarketDataRepository,
    private readonly angelOneAdapter: AngelOneAdapterService,
    private readonly settingsService: SettingsService,
    private readonly signalGateway: SignalGateway,
    private readonly levelBookService: LevelBookService,
    private readonly setupTracker: SetupTrackerService,
    private readonly zoneRepository: ZoneRepository,
    @Optional()
    private readonly optionStrikeSelector: OptionStrikeSelectorService | null = null,
    @Optional()
    private readonly optionsChainService: OptionsChainService | null = null,
    @Optional()
    private readonly contextScoring: ContextScoringService | null = null,
  ) {}

  async analyze(
    token: string,
    exchange: string,
    symbol: string,
    timeframe: string = '15m',
  ): Promise<AnalyzeResult> {
    // Locked-setup short-circuit: if there's already an active setup for
    // this token, return its FROZEN entry/SL/target rather than re-running
    // the strategy. This is the whole point of locking — every poll on the
    // same setup must return the same numbers, not drift with spot.
    // Step 2 of the broker-direct pivot: every analyze() pulls the
    // daily statics (PDH/PDL/prevClose/atr14) fresh from Angel before
    // reading the level book. Live intraday accumulators (VWAP, today's
    // H/L, OR) are preserved by seedSession across the refresh, so the
    // WS-fed live fields stay coherent.
    //
    // We DON'T fail if the broker refresh returns null — fall through to
    // the existing lazyLoad path which has its own DB + broker fallback
    // logic and tolerates partial data (e.g. fresh symbols with < 14
    // daily candles).
    //
    // PERF gate: daily statics (PDH/PDL/prevClose/atr14) only change once
    // per session, but analyze() is polled ~every 60s. Skip the broker
    // refresh when we already refreshed this token within
    // REFRESH_FROM_BROKER_FRESH_MS so repeated polls don't re-hit Angel's
    // historical API every minute. lazyLoad below still returns the cached
    // book, keeping the Setup card live.
    const lastRefreshAt = this.lastBrokerRefreshAt.get(token);
    if (
      lastRefreshAt === undefined ||
      Date.now() - lastRefreshAt >= REFRESH_FROM_BROKER_FRESH_MS
    ) {
      this.lastBrokerRefreshAt.set(token, Date.now());
      await this.levelBookService.refreshFromBroker(token, exchange, symbol);
    }

    const existing = this.setupTracker.getActive(token);
    if (
      existing &&
      (existing.status === 'PENDING' ||
        existing.status === 'ACTIVE' ||
        existing.status === 'PARTIAL_BOOKED')
    ) {
      const liveBook = await this.levelBookService.lazyLoad(token, exchange, symbol);
      // Update tracker against the latest spot so PENDING -> ACTIVE etc.
      // transitions don't lag behind the chart.
      if (liveBook) {
        this.setupTracker.updateFromTick(token, liveBook.spot, new Date());
      }
      const refreshed = this.setupTracker.getActive(token) ?? existing;
      return this.lockedToResult(refreshed, liveBook);
    }

    const book = await this.levelBookService.lazyLoad(token, exchange, symbol);
    if (!book) {
      return {
        kind: 'no-setup',
        reason: 'no level book available — symbol has no historical data',
        levels: null,
        higherTimeframeTrend: null,
        regime: null,
        intradayRangeRatio: 0,
      };
    }

    // Daily regime — driven by today's intraday range vs ATR14. Computed
    // once per analyze() call and threaded into the strategy via AnalyzeInput.
    const { regime, intradayRangeRatio } = classifyRegime({
      intradayRange: book.todayHigh - book.todayLow,
      atr14: book.atr14,
    });

    const instrument = await this.marketDataRepository.getInstrumentByToken(token);
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    // Try DB first when the symbol is seeded; fall back to broker
    // historical API otherwise (any stock the user picks via search).
    let candles: Array<{
      timestamp: Date; open: number; high: number; low: number; close: number; volume: number;
    }> = [];
    if (instrument) {
      const candleRows = await this.marketDataRepository.getCandles(
        instrument.id, timeframe, fiveDaysAgo, now, 25,
      );
      candles = candleRows.map((c) => ({
        timestamp: c.timestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
      }));
    }
    if (candles.length < 25) {
      try {
        const broker = await this.angelOneAdapter.getHistoricalData(
          token, exchange, timeframe, fiveDaysAgo, now,
        );
        candles = broker.slice(-30).map((c: any) => ({
          timestamp: new Date(c.timestamp),
          open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close),
          volume: Number(c.volume) || 0,
        }));
      } catch (err) {
        this.logger.warn(
          `analyze: broker candles fetch failed for ${symbol}/${timeframe}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (candles.length < 25) {
      return {
        kind: 'no-setup',
        reason: `not enough candles (got ${candles.length}, need 25 for ${timeframe})`,
        levels: snapshotFromBook(book),
        higherTimeframeTrend: null,
        regime,
        intradayRangeRatio,
      };
    }

    // Compute the higher-TF trend bias for the MTF gate. If the working
    // TF is daily (no defined higher TF) or if the higher-TF candle fetch
    // can't return enough data, this stays null and the strategy skips the
    // gate (defensive — never let a transient broker error suppress
    // signals).
    const higherTimeframeTrend = await this.computeHigherTimeframeTrend(
      token,
      exchange,
      timeframe,
      instrument?.id ?? null,
      now,
    );

    const istParts = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hh = istParts.find((p) => p.type === 'hour')?.value ?? '00';
    const mm = istParts.find((p) => p.type === 'minute')?.value ?? '00';
    const nowIst = `${hh === '24' ? '00' : hh}:${mm}`;

    const strategy = new LevelsContextStrategy();
    strategy.setParameters({ includeGradeC: true });

    let lastReject = '<gates not evaluated>';
    const debug = (event: string, detail?: Record<string, unknown>) => {
      if (event.startsWith('reject:')) {
        lastReject = detail ? `${event} ${JSON.stringify(detail)}` : event;
      }
    };

    // Bypass staleness here. analyze is invoked on demand by the chart;
    // we're explicitly running historical-or-recent analysis, not waiting
    // for a fresh tick. Pin nowMs to the book's lastTickAt so the
    // staleness gate (1min wall-clock window) always passes. The
    // time-of-day gate still uses real IST so "market closed" returns
    // a useful no-setup reason ("reject:outside-window") instead of a
    // misleading "reject:stale".
    const nowMsForStrategy = book.lastTickAt.getTime() + 1000;
    const zones = await this.zoneRepository.findActiveByToken(token);
    const output = strategy.analyze({
      candles,
      levelBook: book,
      nowIst,
      nowMs: nowMsForStrategy,
      higherTimeframeTrend,
      regime,
      zones,
      debug,
    });

    if (!output) {
      return {
        kind: 'no-setup',
        reason: lastReject,
        levels: snapshotFromBook(book),
        higherTimeframeTrend,
        regime,
        intradayRangeRatio,
      };
    }

    const ctx = output.metadata as SetupContext;

    // Compute the optimal-strike recommendation BEFORE locking so the
    // recommendation is frozen alongside entry/SL/target. Wrapped in
    // try/catch — strike-selection failure must never block the analyze
    // response.
    const recommendedStrike = await this.computeRecommendedStrike(
      output.symbol,
      output.side,
      ctx.entry,
      ctx.target,
      ctx.stoploss,
    );

    // Attach the locked strike to the SetupContext so the GreeksFactor
    // (and any future strike-aware factor) can read delta/gamma without
    // an extra injection. Stored as a structurally-loose ref to avoid a
    // circular import between context-scoring and setup-tracker.
    ctx.recommendedStrike = recommendedStrike;

    // ─── Context scoring — Mama's 10-factor framework ─────────────
    // Runs after the strategy fires but BEFORE counter-setup flagging /
    // lock so the score can soft-gate the grade in-place and the
    // optional hard-gate can early-exit cleanly.
    if (this.contextScoring) {
      try {
        const scored = await this.contextScoring.score({
          side: output.side,
          token,
          symbol: output.symbol,
          exchange: output.exchange,
          setupContext: ctx,
        });
        ctx.contextScore = scored.contextScore;
        ctx.contextTier = scored.contextTier;
        ctx.contextCoverage = scored.contextCoverage;
        ctx.contextFactors = scored.contextFactors;

        // Soft-gate: bump grade based on score thresholds. Score is
        // alignment-with-side so a high positive supports the trade
        // regardless of direction.
        if (scored.contextScore >= 60) {
          ctx.grade = bumpGradeUp(ctx.grade);
        } else if (scored.contextScore <= -30) {
          ctx.grade = bumpGradeDown(ctx.grade);
        }

        // Hard-gate (opt-in via env). When CONTEXT_SCORE_REJECT_BELOW is
        // set to a number, signals at-or-below that score are rejected
        // outright. Off by default.
        const rejectThresholdRaw = process.env.CONTEXT_SCORE_REJECT_BELOW;
        const rejectBelow = rejectThresholdRaw ? Number(rejectThresholdRaw) : NaN;
        if (Number.isFinite(rejectBelow) && scored.contextScore <= rejectBelow) {
          return {
            kind: 'no-setup',
            reason: `reject:context-score (score=${scored.contextScore} <= ${rejectBelow})`,
            levels: snapshotFromBook(book),
            higherTimeframeTrend,
            regime,
            intradayRangeRatio,
          };
        }
      } catch (err) {
        this.logger.warn(
          `Context scoring failed for ${output.symbol} — continuing without score: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Counter-setup invalidation: if there's already an open setup for
    // this token in the OPPOSITE direction, the new fire counts as a
    // confirmation that the prior thesis is wrong. Flag the old one
    // first — lock() short-circuits on any open setup, so the conflict
    // has to be resolved before the new lock can take.
    const existingForCounter = this.setupTracker.getActive(token);
    if (
      existingForCounter &&
      (existingForCounter.status === 'ACTIVE' ||
        existingForCounter.status === 'PARTIAL_BOOKED' ||
        existingForCounter.status === 'PENDING') &&
      existingForCounter.side !== output.side
    ) {
      this.setupTracker.flagCounterSetup(
        token,
        output.side,
        ctx.levelType,
        output.reason,
      );
    }

    const locked = this.setupTracker.lock({
      token,
      symbol: output.symbol,
      exchange: output.exchange,
      side: output.side,
      setupType: ctx.setupType,
      levelType: ctx.levelType,
      levelValue: ctx.levelValue,
      entry: ctx.entry,
      stoploss: ctx.stoploss,
      target: ctx.target,
      partialTakeAt: ctx.partialTakeAt,
      grade: ctx.grade,
      atr14: ctx.atr14,
      indicators: ctx.indicators,
      higherTimeframeTrend: ctx.higherTimeframeTrend,
      regime: ctx.regime,
      intradayRangeRatio: ctx.intradayRangeRatio,
      reason: output.reason,
      recommendedStrike,
      tp1Source: ctx.tp1Source,
      tp1Obstacle: ctx.tp1Obstacle ?? null,
      contextScore: ctx.contextScore,
      contextTier: ctx.contextTier,
      contextCoverage: ctx.contextCoverage,
      contextFactors: ctx.contextFactors,
    });
    // lock() returns null when there's already an active setup — fall back
    // to whatever's active (defensive; the short-circuit above usually
    // catches this path first).
    const final = locked ?? this.setupTracker.getActive(token);
    if (!final) {
      return {
        kind: 'no-setup',
        reason: 'failed to lock setup',
        levels: snapshotFromBook(book),
        higherTimeframeTrend,
        regime,
        intradayRangeRatio,
      };
    }
    return this.lockedToResult(final, book);
  }

  /**
   * Compute the standalone IndicatorReadings (EMA9/21, RSI14, MACD, BB,
   * ROC10 + alignment + agreement) for a token / TF, independent of any
   * setup. Backs the StockOverviewPanel's IndicatorsCard, which needs
   * indicators even when no active setup exists.
   *
   * Reuses the same `buildIndicatorReadings` helper that
   * `LevelsContextStrategy.computeIndicators` delegates to, so the values
   * are byte-identical to what `analyze()` would compute on the same
   * candle window.
   *
   * For alignment: standalone callers don't have a setup direction, so
   * we infer it from the most-recent close vs the prior close. This
   * means "+1" on every chip means "the indicator agrees with the
   * candle's micro-direction" — same semantics as the setup case but
   * derived from price rather than the locked side.
   *
   * Returns null when there aren't enough candles to compute the longer
   * indicators (need ≥ 30 for RSI14 + EMA21 stability).
   */
  async computeIndicatorsFor(
    token: string,
    exchange: string,
    timeframe: string,
  ): Promise<IndicatorReadings | null> {
    const instrument = await this.marketDataRepository.getInstrumentByToken(token);
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    let candles: Array<{
      timestamp: Date; open: number; high: number; low: number; close: number; volume: number;
    }> = [];

    // Try DB first (when symbol is seeded), fall back to broker.
    if (instrument) {
      try {
        const rows = await this.marketDataRepository.getCandles(
          instrument.id, timeframe, fiveDaysAgo, now, 100,
        );
        candles = rows.map((c) => ({
          timestamp: c.timestamp,
          open: c.open, high: c.high, low: c.low, close: c.close,
          volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
        }));
      } catch (err) {
        this.logger.debug(
          `computeIndicatorsFor: DB candle lookup failed for ${token}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (candles.length < 30) {
      try {
        const broker = await this.angelOneAdapter.getHistoricalData(
          token, exchange, timeframe, fiveDaysAgo, now,
        );
        candles = broker.slice(-100).map((c: any) => ({
          timestamp: new Date(c.timestamp),
          open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close),
          volume: Number(c.volume) || 0,
        }));
      } catch (err) {
        this.logger.warn(
          `computeIndicatorsFor: broker candles fetch failed for ${token}/${timeframe}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (candles.length < 30) return null;

    // Direction inference: align to the latest closed bar's micro-direction.
    const lastClose = candles[candles.length - 1].close;
    const prevClose = candles[candles.length - 2].close;
    const isLong = lastClose >= prevClose;

    return buildIndicatorReadings(candles, lastClose, isLong);
  }

  private lockedToResult(
    setup: LockedSetup,
    book: LevelBook | null,
  ): AnalyzeResult {
    return {
      kind: 'setup',
      symbol: setup.symbol,
      side: setup.side,
      entry: setup.entry,
      stoploss: setup.stoploss,
      target: setup.target,
      partialTakeAt: setup.partialTakeAt,
      trailingSl: setup.trailingSl,
      levelType: setup.levelType,
      setupType: setup.setupType,
      grade: setup.grade,
      atr14: setup.atr14,
      // volumeRatio is part of the original setupContext but not held by
      // the locked record — surface 0 when re-serving an existing lock.
      volumeRatio: 0,
      levels: book
        ? snapshotFromBook(book)
        : {
            pdh: 0, pdl: 0, orh: null, orl: null,
            prevOrh: null, prevOrl: null,
            vwap: 0, todayHigh: 0, todayLow: 0, atr14: setup.atr14,
          },
      reason: setup.reason,
      indicators: setup.indicators,
      higherTimeframeTrend: setup.higherTimeframeTrend,
      regime: setup.regime,
      intradayRangeRatio: setup.intradayRangeRatio,
      status: setup.status,
      setupId: setup.id,
      triggeredAt: setup.triggeredAt ? setup.triggeredAt.toISOString() : null,
      partialBookedAt: setup.partialBookedAt
        ? setup.partialBookedAt.toISOString()
        : null,
      recommendedStrike: setup.recommendedStrike ?? null,
      invalidationKind: setup.invalidationKind ?? null,
      invalidationReason: setup.invalidationReason ?? null,
      tp1Source: setup.tp1Source,
      tp1Obstacle: setup.tp1Obstacle ?? null,
      contextScore: setup.contextScore,
      contextTier: setup.contextTier,
      contextCoverage: setup.contextCoverage,
      contextFactors: setup.contextFactors,
    };
  }

  /**
   * Pick the highest-scoring strike around ATM and convert it into a
   * trader-facing recommendation with expected per-share / per-lot premium
   * P&L. Returns null whenever the options chain isn't available (off-hours,
   * stocks without F&O, or transient broker errors) — the caller treats
   * null as "no recommendation" and continues.
   */
  private async computeRecommendedStrike(
    symbol: string,
    side: 'BUY' | 'SELL',
    entry: number,
    target: number,
    stoploss: number,
  ): Promise<RecommendedStrike | null> {
    if (!this.optionStrikeSelector || !this.optionsChainService) return null;
    try {
      const expiries = await this.optionsChainService.getExpiries(symbol);
      if (expiries.length === 0) return null;
      const expiry = expiries[0];
      const optionSide: 'CE' | 'PE' = side === 'BUY' ? 'CE' : 'PE';
      const sel = await this.optionStrikeSelector.selectBestStrike({
        underlying: symbol,
        expiry,
        side: optionSide,
      });
      if (!sel) return null;

      const targetMove = Math.abs(target - entry);
      const slMove = Math.abs(entry - stoploss);
      const expectedProfitPerShare =
        sel.delta * targetMove + 0.5 * sel.gamma * targetMove * targetMove;
      const expectedLossPerShare =
        sel.delta * slMove + 0.5 * sel.gamma * slMove * slMove;

      const lotSize = resolveOptionLotSize(symbol);
      const expectedProfitPerLot = expectedProfitPerShare * lotSize;
      const expectedLossPerLot = expectedLossPerShare * lotSize;

      return {
        strike: sel.strikePrice,
        side: sel.side,
        expiry: sel.expiry,
        ltp: sel.ltp,
        delta: sel.delta,
        gamma: sel.gamma,
        theta: sel.theta,
        vega: sel.vega,
        iv: sel.iv,
        oi: sel.oi,
        volume: sel.volume,
        expectedProfitPerShare:
          Math.round(expectedProfitPerShare * 100) / 100,
        expectedLossPerShare:
          Math.round(expectedLossPerShare * 100) / 100,
        lotSize,
        expectedProfitPerLot: Math.round(expectedProfitPerLot * 100) / 100,
        expectedLossPerLot: Math.round(expectedLossPerLot * 100) / 100,
        reason: sel.reason,
      };
    } catch (err) {
      this.logger.warn(
        `Strike recommendation failed for ${symbol}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return null;
    }
  }

  /**
   * Run all active strategies against a market snapshot.
   * Scores results, filters by multi-timeframe confirmation, saves to DB,
   * and emits via WebSocket gateway.
   */
  async scanForSignals(snapshot: MarketSnapshot): Promise<void> {
    const strategies = await this.strategyRegistry.getActiveStrategies();

    if (strategies.length === 0) {
      this.logger.debug('No active strategies to scan with');
      return;
    }

    const rawSignals: Array<{ signal: SignalOutput; strategyName: string }> = [];

    for (const strategy of strategies) {
      try {
        const signal = strategy.analyze(snapshot);
        if (signal) {
          rawSignals.push({ signal, strategyName: strategy.name });
          this.logger.debug(
            `[${strategy.name}] ${snapshot.symbol}: SIGNAL ${signal.side} @ ${signal.entryPrice} (candles: ${snapshot.candles.length})`,
          );
        } else {
          this.logger.debug(
            `[${strategy.name}] ${snapshot.symbol}: no signal (candles: ${snapshot.candles.length}, ltp: ${snapshot.ltp})`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Strategy "${strategy.name}" error for ${snapshot.symbol}: ` +
            `${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (rawSignals.length === 0) {
      return;
    }

    // Multi-timeframe confirmation: count how many signals agree on direction
    const directionCounts = this.countDirectionAgreements(rawSignals);

    for (const { signal, strategyName } of rawSignals) {
      const timeframeAlignments = directionCounts[signal.side] ?? 1;

      // Skip signals that don't meet multi-timeframe minimum
      if (timeframeAlignments < MIN_TIMEFRAME_AGREEMENT && rawSignals.length > 1) {
        this.logger.debug(
          `Signal for ${signal.symbol} ${signal.side} skipped — ` +
            `only ${timeframeAlignments} TF agreement (need ${MIN_TIMEFRAME_AGREEMENT})`,
        );
        continue;
      }

      const scoreResult = await this.signalScoring.scoreSignal(
        signal,
        snapshot,
        strategyName,
        timeframeAlignments,
      );

      if (!scoreResult) {
        continue; // Discarded by scoring (below threshold)
      }

      try {
        const savedSignal = await this.saveSignal(
          signal,
          snapshot,
          strategyName,
          scoreResult.score,
          scoreResult.confidence,
        );

        this.signalGateway.emitNewSignal(savedSignal);

        this.logger.log(
          `Signal generated: ${signal.symbol} ${signal.side} @ ${signal.entryPrice} ` +
            `[${strategyName}] score=${scoreResult.score} (${scoreResult.confidence})`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to save signal for ${signal.symbol}: ` +
            `${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  /**
   * Scan all instruments in the current watchlist.
   * Falls back to all cached quote tokens when no WebSocket subscriptions exist.
   */
  async scanAllWatchlist(): Promise<void> {
    let tokens = this.marketFeedService.getSubscribedTokens();

    // Fall back to all tokens that have cached quotes (from REST polling)
    if (tokens.length === 0) {
      const allQuotes = this.marketFeedService.getAllQuotes();
      tokens = allQuotes.map((q) => q.token);
    }

    if (tokens.length === 0) {
      this.logger.debug('No subscribed tokens or cached quotes to scan');
      return;
    }

    // Determine which exchanges are currently open so we skip stale data
    const nseOpen = this.isExchangeOpen('NSE');
    const mcxOpen = this.isExchangeOpen('MCX');

    this.logger.log(
      `Scanning ${tokens.length} instruments for signals (NSE: ${nseOpen ? 'OPEN' : 'CLOSED'}, MCX: ${mcxOpen ? 'OPEN' : 'CLOSED'})`,
    );

    let scanned = 0;
    let skipped = 0;

    for (const token of tokens) {
      try {
        // Check if the token's exchange is currently open
        const quote = this.marketFeedService.getQuote(token);
        if (quote) {
          const exchange = quote.exchange;
          const isMcx = exchange === Exchange.MCX;
          const isNseOrBse =
            exchange === Exchange.NSE ||
            exchange === Exchange.BSE ||
            exchange === Exchange.NFO;

          if (isMcx && !mcxOpen) {
            skipped++;
            continue;
          }
          if (isNseOrBse && !nseOpen) {
            skipped++;
            continue;
          }
        }

        const snapshot = await this.buildSnapshotForToken(token);
        if (snapshot) {
          await this.scanForSignals(snapshot);
          scanned++;
        }
      } catch (error) {
        this.logger.error(
          `Error scanning token ${token}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (skipped > 0) {
      this.logger.debug(
        `Skipped ${skipped} tokens (exchange closed), scanned ${scanned}`,
      );
    }
  }

  /**
   * Get currently active signals, plus optionally recently-expired ones
   * from the last `recentHours` window. The Signals page uses the recent
   * window so a trader checking in mid-afternoon can still see the
   * morning's signals (now expired but still informative).
   */
  async getActiveSignals(recentHours = 0) {
    return this.signalRepository.getActiveSignals(recentHours);
  }

  /**
   * Get signal history with filters and pagination.
   */
  async getSignalHistory(filters: SignalFilterDto) {
    return this.signalRepository.getSignalHistory(filters);
  }

  /**
   * Deactivate a signal by ID.
   */
  async deactivateSignal(id: string) {
    const signal = await this.signalRepository.deactivateSignal(id);
    this.signalGateway.emitSignalExpired(id);
    return signal;
  }

  /**
   * Cron job to deactivate signals whose expiresAt has passed.
   * Fires every 5 minutes between 09:00–23:35 IST (Mon-Fri) so it
   * covers both NSE close (15:30) and MCX close (23:30). Each signal's
   * TTL is set at creation time by computeExpiry() — this cron just
   * sweeps the ones that are past due.
   */
  @Cron('*/5 9-23 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async expireOldSignals(): Promise<void> {
    try {
      const count = await this.signalRepository.deactivateExpiredSignals();

      if (count > 0) {
        this.logger.log(`Expired ${count} old signals`);
      }

      // Legacy backfill: signals created before the expiresAt-on-create
      // fix have a NULL expiry and would otherwise live forever. Sweep
      // anything older than 24h with no TTL set. Safe to run every tick —
      // it's idempotent (updateMany only flips rows still isActive=true).
      const legacy = await this.signalRepository.deactivateLegacyNullExpiry();
      if (legacy > 0) {
        this.logger.log(`Deactivated ${legacy} legacy signals with null expiresAt`);
      }
    } catch (error) {
      this.logger.error(
        `Error expiring signals: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ------------------------------------------------------------------
  //  Private helpers
  // ------------------------------------------------------------------

  /**
   * Check whether a specific exchange is currently open (IST-based).
   * NSE/BSE/NFO: 9:15 – 15:30, Mon–Fri
   * MCX: 9:00 – 23:30, Mon–Fri
   */
  private isExchangeOpen(exchange: 'NSE' | 'MCX'): boolean {
    const now = new Date();
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
    const minutes = Number(
      istParts.find((p) => p.type === 'minute')?.value ?? 0,
    );
    const totalMinutes = hours * 60 + minutes;

    if (exchange === 'MCX') {
      const mcxOpen = MCX_OPEN_HOUR * 60 + MCX_OPEN_MINUTE;
      const mcxClose = MCX_CLOSE_HOUR * 60 + MCX_CLOSE_MINUTE;
      return totalMinutes >= mcxOpen && totalMinutes <= mcxClose;
    }

    // NSE/BSE/NFO
    const nseOpen = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
    const nseClose = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;
    return totalMinutes >= nseOpen && totalMinutes <= nseClose;
  }

  /**
   * Build a MarketSnapshot from a token's cached quote and recent candles.
   * Tries the DB first, then falls back to fetching historical data from the
   * Angel One REST API so that strategies have enough candles for indicator
   * calculations (RSI, EMA, ATR, etc.).
   */
  private async buildSnapshotForToken(
    token: string,
  ): Promise<MarketSnapshot | null> {
    const quote = this.marketFeedService.getQuote(token);
    if (!quote) {
      return null;
    }

    // We need enough candles for the most demanding strategy.
    // EMA crossover needs signalPeriod(50) + 2 = 52 candles minimum.
    // RSI needs 26+ candles. Use 5 days of 15-min candles (~125 candles)
    // to ensure sufficient data even for commodities with limited intraday history.
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    let candles: Array<{
      timestamp: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: bigint | number;
    }> = [];

    try {
      // Look up instrument by token to get instrumentId
      const instrument = await this.marketDataRepository.getInstrumentByToken(token);
      if (instrument) {
        const dbCandles = await this.marketDataRepository.getCandles(
          instrument.id,
          TIMEFRAMES.FIFTEEN_MIN,
          fiveDaysAgo,
          now,
        );
        candles = dbCandles;
      }
    } catch (error) {
      this.logger.debug(
        `Could not fetch candles from DB for token ${token}: ${error instanceof Error ? error.message : error}`,
      );
    }

    // If DB has insufficient candles, fetch from Angel One REST API directly
    if (candles.length < 52) {
      try {
        const apiCandles = await this.angelOneAdapter.getHistoricalData(
          token,
          quote.exchange,
          TIMEFRAMES.FIFTEEN_MIN,
          fiveDaysAgo,
          now,
        );

        if (apiCandles && apiCandles.length > candles.length) {
          candles = apiCandles;
          this.logger.debug(
            `Fetched ${apiCandles.length} candles from API for ${quote.symbol} (DB had ${candles.length})`,
          );
        }
      } catch (error) {
        this.logger.debug(
          `Could not fetch candles from API for token ${token}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return {
      symbol: quote.symbol,
      exchange: quote.exchange,
      ltp: quote.ltp,
      volume: quote.volume,
      candles: candles.map((c) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
      })),
    };
  }

  /**
   * Compute the higher-TF trend bias (bullish/bearish/neutral) from EMA9
   * vs EMA21 on the most-recent CLOSED candle of the higher TF. Returns
   * null when:
   *   • the working TF has no defined higher TF (e.g. 1d)
   *   • we couldn't fetch enough higher-TF candles
   *   • EMA computation fails (insufficient series length)
   *
   * The strategy treats null as "skip the gate" so a transient broker
   * failure here never suppresses signals.
   */
  private async computeHigherTimeframeTrend(
    token: string,
    exchange: string,
    workingTimeframe: string,
    instrumentId: string | null,
    now: Date,
  ): Promise<SetupContext['higherTimeframeTrend']> {
    const higherTf = HIGHER_TF_MAP[workingTimeframe];
    if (!higherTf) return null;

    const from = new Date(
      now.getTime() - HIGHER_TF_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );

    let candles: Array<{ close: number }> = [];

    if (instrumentId) {
      try {
        const dbRows = await this.marketDataRepository.getCandles(
          instrumentId,
          higherTf,
          from,
          now,
          HIGHER_TF_CANDLE_TARGET,
        );
        candles = dbRows.map((c) => ({ close: c.close }));
      } catch (err) {
        this.logger.debug(
          `MTF DB fetch failed for token ${token} ${higherTf}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (candles.length < 22) {
      try {
        const broker = await this.angelOneAdapter.getHistoricalData(
          token, exchange, higherTf, from, now,
        );
        candles = (broker as Array<{ close: number | string }>).slice(
          -HIGHER_TF_CANDLE_TARGET,
        ).map((c) => ({ close: Number(c.close) }));
      } catch (err) {
        this.logger.debug(
          `MTF broker fetch failed for token ${token} ${higherTf}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (candles.length < 22) return null;

    // Use the most-recent CLOSED bar (length-2). If only one bar is
    // present we can't safely drop the in-progress one; fall back to the
    // last available close.
    const closesUpToClosed =
      candles.length >= 2
        ? candles.slice(0, -1).map((c) => c.close)
        : candles.map((c) => c.close);

    const ema9Val = ema(closesUpToClosed, 9);
    const ema21Val = ema(closesUpToClosed, 21);
    if (ema9Val == null || ema21Val == null) return null;

    let bias: 'bullish' | 'bearish' | 'neutral';
    if (ema9Val > ema21Val * 1.001) bias = 'bullish';
    else if (ema9Val < ema21Val * 0.999) bias = 'bearish';
    else bias = 'neutral';

    return { tf: higherTf, ema9: ema9Val, ema21: ema21Val, bias };
  }

  /**
   * Count how many strategies agree on each direction (BUY/SELL).
   * Used for multi-strategy confirmation. Counts unique strategies, not
   * unique timeframes, so that two strategies on the same timeframe still
   * provide confirmation.
   */
  private countDirectionAgreements(
    signals: Array<{ signal: SignalOutput; strategyName: string }>,
  ): Record<string, number> {
    const counts: Record<string, number> = { BUY: 0, SELL: 0 };

    const buyStrategies = new Set<string>();
    const sellStrategies = new Set<string>();

    for (const { signal, strategyName } of signals) {
      if (signal.side === 'BUY') {
        buyStrategies.add(strategyName);
      } else {
        sellStrategies.add(strategyName);
      }
    }

    counts.BUY = buyStrategies.size;
    counts.SELL = sellStrategies.size;

    return counts;
  }

  /**
   * Save a scored signal to the database.
   */
  private async saveSignal(
    signal: SignalOutput,
    snapshot: MarketSnapshot,
    strategyName: string,
    score: number,
    confidence: string,
  ) {
    // Resolve instrumentId from the symbol/exchange
    let instrumentId: string | null = null;

    try {
      const instruments = await this.marketDataRepository.searchInstruments(
        signal.symbol,
        signal.exchange,
      );
      if (instruments.length > 0) {
        instrumentId = instruments[0].id;
      }
    } catch {
      // Will use a fallback if instrument not found
    }

    if (!instrumentId) {
      this.logger.warn(
        `Instrument not found for ${signal.symbol}/${signal.exchange} — skipping signal save`,
      );
      throw new Error(`Instrument not found for ${signal.symbol}`);
    }

    const expectedProfit = Math.abs(signal.targetPrice - signal.entryPrice);
    const expectedLoss = Math.abs(signal.entryPrice - signal.stoplossPrice);
    const riskRewardRatio = expectedLoss > 0 ? expectedProfit / expectedLoss : 0;

    const expiresAt = computeExpiry(signal.exchange);

    const input: CreateSignalInput = {
      instrumentId,
      side: signal.side,
      entryPrice: signal.entryPrice,
      targetPrice: signal.targetPrice,
      stoplossPrice: signal.stoplossPrice,
      expectedProfit: Math.round(expectedProfit * 100) / 100,
      expectedLoss: Math.round(expectedLoss * 100) / 100,
      riskRewardRatio: Math.round(riskRewardRatio * 100) / 100,
      confidence,
      confidenceScore: score,
      strategy: strategyName,
      timeframe: signal.timeframe,
      reason: signal.reason,
      expiresAt,
    };

    return this.signalRepository.createSignal(input);
  }
}

/** Promote one grade tier (C → B → A, A stays A). Used by the context-score soft-gate. */
function bumpGradeUp(grade: 'A' | 'B' | 'C'): 'A' | 'B' | 'C' {
  if (grade === 'C') return 'B';
  if (grade === 'B') return 'A';
  return 'A';
}

/** Demote one grade tier (A → B → C, C stays C). Used by the context-score soft-gate. */
function bumpGradeDown(grade: 'A' | 'B' | 'C'): 'A' | 'B' | 'C' {
  if (grade === 'A') return 'B';
  if (grade === 'B') return 'C';
  return 'C';
}
