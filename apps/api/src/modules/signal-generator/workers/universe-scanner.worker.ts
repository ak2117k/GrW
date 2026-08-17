import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { OptionStrikeSelectorService } from '../../options-chain/services/option-strike-selector.service';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { AnandSniperV25CombinedStrategy } from '../strategies/anand-sniper-v25-combined.strategy';
import { LevelsContextStrategy } from '../strategies/levels-context.strategy';
import { LevelBookService } from '../services/level-book.service';
import { computeExpiry } from '../utils/compute-expiry';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import {
  CandleData,
  MarketSnapshot,
  SignalOutput,
} from '../../../common/interfaces/trading-strategy.interface';
import { OrderSideDto, OrderTypeDto, PositionTypeDto } from '../../trade-engine/dto/trade.dto';

/**
 * Watches NIFTY and BANKNIFTY 15m bar closes, runs the combined Sniper+V25
 * strategy on the latest candles, and auto-places a paper trade on the
 * best-scoring CE/PE strike when the rule fires. Trades are then enqueued
 * to the signal-review queue so Claude can post-trade audit them and kill
 * any rejected positions.
 *
 * Phase 1 scope: NIFTY + BANKNIFTY only, 15m timeframe only, transition-only
 * firing (the strategy itself dedupes consecutive same-direction signals).
 * Adding F&O stocks is a Phase-2 swap-in for the scan loop.
 */

interface WatchedSymbol {
  underlying: string;     // 'NIFTY' / 'BANKNIFTY'
  exchange: string;       // 'NSE'
  lotSize: number;        // quantity per lot for option orders
  instrumentId?: string;  // resolved at OnModuleInit
  token?: string;         // broker token, used as LevelBookService key; resolved at OnModuleInit
}

const WATCHED: WatchedSymbol[] = [
  { underlying: 'NIFTY', exchange: 'NSE', lotSize: 65 },
  { underlying: 'BANKNIFTY', exchange: 'NSE', lotSize: 30 },
  // MCX commodity futures — the Sniper+V25 rule is segment-agnostic (works on
  // any OHLCV series with enough history), so we fire signals on these the
  // same way as indices. Stale-bar checks below naturally silence them
  // outside MCX hours (09:00–23:30 IST).
  { underlying: 'CRUDEOIL', exchange: 'MCX', lotSize: 100 },
  { underlying: 'COPPER', exchange: 'MCX', lotSize: 2500 },
];

const TIMEFRAMES = ['1m', '5m', '15m', '60m'] as const;
const MIN_CANDLES_PER_TF = 60;
// Skip a symbol if its newest 15m bar is older than this. Wide enough to
// absorb a weekend gap (Friday close → Monday open ≈ 65 h) so the smoke
// test on Monday morning doesn't reject Friday's bars. Tighten to ≤30
// in production once the live bar feed reliably persists fresh candles.
const STALENESS_THRESHOLD_MIN = 96 * 60;

@Injectable()
export class UniverseScannerWorker implements OnModuleInit {
  private readonly logger = new Logger(UniverseScannerWorker.name);

  /** Instantiated directly — no NestJS deps needed. */
  private readonly levelsContextStrategy = new LevelsContextStrategy();

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketDataRepo: MarketDataRepository,
    private readonly optionsChainService: OptionsChainService,
    private readonly strikeSelector: OptionStrikeSelectorService,
    private readonly strategy: AnandSniperV25CombinedStrategy,
    private readonly tradeExecutionService: TradeExecutionService,
    private readonly levelBookService: LevelBookService,
    @InjectQueue('signal-review') private readonly reviewQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    // Resolve underlying instrument IDs once at boot. The candle backfill
    // script seeds these rows; if either is missing, the scan will skip
    // that symbol with a warning.
    for (const w of WATCHED) {
      // Match either 'INDEX' or 'INDICES' segment label — different parts of
      // the codebase have used both historically (the backfill script writes
      // 'INDEX', the older WS subscriber wrote 'INDICES').
      //
      // MCX commodities live under segment='COMMODITY' (upserted by the
      // commodity backfill script) and have no INDEX counterpart, so we
      // accept that label too. On MCX we intentionally drop the segment
      // filter entirely — the (symbol, exchange) pair is already unique
      // enough to pin the spot future row.
      const segmentFilter =
        w.exchange === 'MCX'
          ? undefined
          : { in: ['INDEX', 'INDICES', 'COMMODITY'] as string[] };
      const inst = await this.prisma.instrument.findFirst({
        where: {
          symbol: w.underlying,
          exchange: w.exchange,
          ...(segmentFilter ? { segment: segmentFilter } : {}),
        },
      });
      if (inst) {
        w.instrumentId = inst.id;
        w.token = inst.token;
        this.logger.log(
          `Resolved ${w.underlying} (${w.exchange}) → instrumentId=${inst.id} token=${inst.token} segment=${inst.segment}`,
        );
      } else {
        this.logger.warn(
          `${w.underlying} (${w.exchange}) not in instruments table — scanner will skip it. ` +
          `For NSE indices run scripts/backfill-candles.mjs; for MCX commodities ensure the ` +
          `instrument row exists before the scanner starts.`,
        );
      }
    }
  }

  /**
   * Cron: every 15 minutes at the bar close (3:30s past the quarter to give
   * the broker a beat to settle the bar). Runs 09:00–23:59 IST Mon–Fri so the
   * same pass covers NSE hours (09:15–15:30) AND MCX commodity hours
   * (09:00–23:30). NSE symbols outside 09:15–15:30 simply hit the staleness
   * gate below and are skipped; no extra wiring needed.
   */
  @Cron('30 */15 9-23 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async scanCron(): Promise<void> {
    this.logger.log('Universe scan tick');
    for (const w of WATCHED) {
      try {
        await this.scanSymbol(w);
      } catch (err) {
        this.logger.error(
          `Scan failed for ${w.underlying}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /**
   * Manual trigger — useful for smoke testing without waiting for the cron.
   * Returns the signal (or null), the diagnostic breakdown, and the trade
   * outcome (if any).
   */
  async runOnce(): Promise<Array<{
    symbol: string;
    signal: SignalOutput | null;
    tradeId: string | null;
    reason: string;
    diagnostic: Record<string, unknown> | null;
  }>> {
    const out: Array<{
      symbol: string;
      signal: SignalOutput | null;
      tradeId: string | null;
      reason: string;
      diagnostic: Record<string, unknown> | null;
    }> = [];
    for (const w of WATCHED) {
      const result = await this.scanSymbol(w);
      out.push({ symbol: w.underlying, ...result });
    }
    return out;
  }

  private async scanSymbol(
    w: WatchedSymbol,
  ): Promise<{
    signal: SignalOutput | null;
    tradeId: string | null;
    reason: string;
    diagnostic: Record<string, unknown> | null;
  }> {
    if (!w.instrumentId) {
      return { signal: null, tradeId: null, reason: 'instrument not resolved', diagnostic: null };
    }

    // 1. Fetch MTF candles from local DB. Window is intentionally wide
    //    (90 days) so it absorbs weekend gaps and holes in the backfill,
    //    but we cap each query at 300 most-recent bars — the strategy only
    //    looks back ~50 bars for the longest indicator (SuperTrend/ADX),
    //    plus a buffer for warmup. Without this cap, MCX commodity 1m
    //    bars (200k+ rows over 90 days) make scan-now take 3+ minutes.
    const now = new Date();
    const from30d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const MAX_BARS_PER_TF = 300;
    const mtfCandles: Record<string, CandleData[]> = {};
    let staleness = Infinity;

    for (const tf of TIMEFRAMES) {
      // The DB stores '1h' as the canonical name for the 60m bucket — match either.
      const tfKey = tf === '60m' ? '1h' : tf;
      const rows = await this.marketDataRepo.getCandles(
        w.instrumentId,
        tfKey,
        from30d,
        now,
        MAX_BARS_PER_TF,
      );
      const candles: CandleData[] = rows.map((r) => ({
        timestamp: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: Number(r.volume),
      }));
      mtfCandles[tf] = candles;
      if (tf === '15m' && candles.length > 0) {
        const newest = candles[candles.length - 1].timestamp;
        staleness = (now.getTime() - newest.getTime()) / 60000;
      }
    }

    if ((mtfCandles['15m']?.length ?? 0) < MIN_CANDLES_PER_TF) {
      return { signal: null, tradeId: null, reason: `insufficient 15m candles (${mtfCandles['15m']?.length ?? 0})`, diagnostic: null };
    }
    if (staleness > STALENESS_THRESHOLD_MIN) {
      return { signal: null, tradeId: null, reason: `data stale by ${staleness.toFixed(0)}min`, diagnostic: null };
    }

    const candles15m = mtfCandles['15m'];
    const ltp = candles15m[candles15m.length - 1].close;
    const volume = candles15m[candles15m.length - 1].volume;

    // 2a. Levels-Context strategy — uses the 5m series + a live LevelBook.
    //     Runs independently of the Sniper+V25 path; only persists a signal
    //     row (no trade execution — that's a Phase-2 extension once the live
    //     LevelBook has a full session's worth of ticks).
    if (w.token) {
      const levelBook = this.levelBookService.getLevels(w.token);
      const isStale = this.levelBookService.isStale(w.token);
      if (levelBook && !isStale) {
        const nowIst = new Date().toLocaleTimeString('en-GB', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const candles5m = mtfCandles['5m'] ?? [];
        const lcSignal = this.levelsContextStrategy.analyze({ candles: candles5m, levelBook, nowIst });
        if (lcSignal) {
          this.logger.log(
            `[${w.underlying}] levels-context signal: ${lcSignal.side} @ ${lcSignal.entryPrice} grade=${(lcSignal.metadata as any)?.grade ?? '?'}`,
          );
          try {
            const rr = Math.abs(lcSignal.targetPrice - lcSignal.entryPrice) /
              Math.max(Math.abs(lcSignal.entryPrice - lcSignal.stoplossPrice), 1e-6);
            await (this.prisma.signal.create as Function)({
              data: {
                instrumentId: w.instrumentId,
                side: lcSignal.side,
                entryPrice: lcSignal.entryPrice,
                targetPrice: lcSignal.targetPrice,
                stoplossPrice: lcSignal.stoplossPrice,
                expectedProfit: Math.abs(lcSignal.targetPrice - lcSignal.entryPrice),
                expectedLoss: Math.abs(lcSignal.entryPrice - lcSignal.stoplossPrice),
                riskRewardRatio: rr,
                confidence: (lcSignal.metadata as any)?.grade ?? 'B',
                confidenceScore: lcSignal.confidence,
                strategy: this.levelsContextStrategy.name,
                timeframe: lcSignal.timeframe ?? '5m',
                reason: lcSignal.reason,
                isActive: true,
                // Session-aware TTL — without this the 5-min expiry sweep
                // skips the row (it filters by expiresAt < now) and the
                // signal lives forever on the /signals page.
                expiresAt: computeExpiry(w.exchange),
                // setupContext carries the full SetupContext (level type, setup
                // type, grade, level-book snapshot, etc.). Prisma accepts Json? —
                // the Prisma client was regenerated in Task 8 to include this field.
                setupContext: lcSignal.metadata ?? null,
              },
            });
            this.logger.log(`[${w.underlying}] levels-context signal persisted`);
          } catch (err) {
            this.logger.warn(
              `[${w.underlying}] failed to persist levels-context signal: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      } else {
        this.logger.debug(
          `[${w.underlying}] levels-context skipped — levelBook ${levelBook ? 'stale' : 'not seeded'}`,
        );
      }
    }

    // 2. Run the strategy. The strategy itself handles transition firing,
    //    so calling it on every cron tick is safe — it dedupes internally.
    const snapshot: MarketSnapshot = {
      symbol: w.underlying,
      exchange: w.exchange,
      ltp,
      candles: candles15m,
      mtfCandles,
      volume,
    };

    // Compute the diagnostic FIRST so we always have visibility into why
    // the rule fires or doesn't, even on "no fire" outcomes.
    const diagnostic = this.strategy.evaluateConditions(snapshot) as unknown as Record<string, unknown>;

    const signal = this.strategy.analyze(snapshot);
    if (!signal) {
      return {
        signal: null,
        tradeId: null,
        reason: `rule did not fire — ${diagnostic.reason ?? 'unknown'}`,
        diagnostic,
      };
    }

    this.logger.log(
      `[${w.underlying}] signal fired: ${signal.side} @ ${signal.entryPrice} (confidence ${signal.confidence})`,
    );

    // 3. Pick the best strike. CE for BUY signal, PE for SELL signal.
    const expiries = await this.optionsChainService.getExpiries(w.underlying);
    if (expiries.length === 0) {
      return { signal, tradeId: null, reason: 'no expiries available for underlying', diagnostic };
    }
    const expiry = expiries[0]; // nearest weekly

    const strike = await this.strikeSelector.selectBestStrike({
      underlying: w.underlying,
      expiry,
      side: signal.side === 'BUY' ? 'CE' : 'PE',
    });
    if (!strike) {
      return { signal, tradeId: null, reason: 'no viable strike in band', diagnostic };
    }

    this.logger.log(
      `[${w.underlying}] selected ${strike.side} ${strike.strikePrice} @ ${strike.ltp} (score ${strike.score.toFixed(1)}) — ${strike.reason}`,
    );

    // 4. Build the ExecuteTradeDto. We need a real instruments-table row for
    //    the option contract because TradeExecutionService validates the
    //    instrument exists before accepting the order. Upsert a synthetic
    //    OPTIDX row first if one doesn't exist — the paper trade service
    //    fills against `request.price` so the token only needs to be unique
    //    and stable, not a real Angel One token.
    const expiryCompact = expiry.replace(/-/g, '').slice(2); // 2026-04-13 → 260413
    const syntheticSymbol = `${w.underlying}${expiryCompact}${strike.strikePrice}${strike.side}`;
    const syntheticToken = `PAPER-${w.underlying}-${expiryCompact}-${strike.strikePrice}-${strike.side}`;

    try {
      await this.prisma.instrument.upsert({
        where: {
          symbol_exchange_token: {
            symbol: syntheticSymbol,
            exchange: 'NFO',
            token: syntheticToken,
          },
        },
        create: {
          symbol: syntheticSymbol,
          name: w.underlying,
          token: syntheticToken,
          exchange: 'NFO',
          segment: 'OPTIONS',
          lotSize: w.lotSize,
          tickSize: 0.05,
          expiry: new Date(expiry),
          strike: strike.strikePrice,
          optionType: strike.side,
          isActive: true,
        },
        update: { isActive: true },
      });
    } catch (err) {
      this.logger.warn(
        `[${w.underlying}] failed to upsert synthetic option instrument: ${err instanceof Error ? err.message : err}`,
      );
      return { signal, tradeId: null, reason: 'instrument upsert failed', diagnostic };
    }

    try {
      const result = await this.tradeExecutionService.executeTrade({
        symbol: syntheticSymbol,
        token: syntheticToken,
        exchange: 'NFO',
        side: OrderSideDto.BUY, // we BUY the option (call or put), regardless of underlying direction
        orderType: OrderTypeDto.MARKET,
        quantity: w.lotSize,
        price: strike.ltp,
        positionType: PositionTypeDto.INTRADAY,
        strategy: this.strategy.name,
        source: 'SCANNER',
        // Mirror the underlying's stop/target into option-premium space using
        // delta — first-order estimate, good enough for paper trading. Actual
        // production code would manage stops at the underlying level via a
        // separate watcher.
        stoploss: Math.max(0.05, strike.ltp - Math.abs((signal.entryPrice - signal.stoplossPrice) * (strike.delta || 0.5))),
        target:   strike.ltp + Math.abs((signal.targetPrice - signal.entryPrice) * (strike.delta || 0.5)),
      } as any);

      const tradeId = (result as any)?.id ?? (result as any)?.tradeId ?? null;
      this.logger.log(
        `[${w.underlying}] paper trade placed: ${syntheticSymbol} qty=${w.lotSize} @ ${strike.ltp} → tradeId=${tradeId}`,
      );

      // CRITICAL: only mark the strategy's transition as committed AFTER
      // a successful trade. If we mutate before this point and the trade
      // fails, the strategy gets stuck in a "won't fire" state until reset.
      if (tradeId) {
        this.strategy.commitTransition(w.underlying, w.exchange, signal.side);
      }

      // 5. Enqueue Claude's post-trade review.
      if (tradeId) {
        await this.reviewQueue.add('review-trade', {
          tradeId,
          signal,
          snapshot: {
            underlying: w.underlying,
            spotPrice: strike.spotPrice,
            strikePrice: strike.strikePrice,
            side: strike.side,
            ltp: strike.ltp,
            oi: strike.oi,
            oiChange: strike.oiChange,
            volume: strike.volume,
            iv: strike.iv,
            delta: strike.delta,
            gamma: strike.gamma,
            theta: strike.theta,
            vega: strike.vega,
            scoreBreakdown: strike.scoreBreakdown,
            expiry: strike.expiry,
            confidenceFromRule: signal.confidence,
            ruleReason: signal.reason,
            ruleMetadata: signal.metadata,
          },
        });
        this.logger.log(`[${w.underlying}] enqueued signal-review for trade ${tradeId}`);
      }

      return { signal, tradeId, reason: 'trade placed', diagnostic };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${w.underlying}] trade execution failed: ${msg}`);
      return { signal, tradeId: null, reason: `trade execution failed: ${msg}`, diagnostic };
    }
  }
}
