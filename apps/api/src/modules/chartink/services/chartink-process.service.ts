import { Injectable, Logger, Optional } from '@nestjs/common';
import { ChartinkRepository, CreateAlertSetupInput } from '../repositories/chartink.repository';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { ChartinkScoringService, classifyTrend, ScoringCandleSource } from './chartink-scoring.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../market-data/services/nse-sector-index.service';
import { WatchService, WatchCapExceededError, TradeCooldownError } from '../../watch-monitor/services/watch.service';
import { formatTradeRejection } from '../../../common/utils/trade-rejection-log';
import { isWithinEntryWindow } from '../../../common/utils/market-hours';
import { evaluateTradePolicy } from '../../watch-monitor/services/trade-policy';
import { UngatedWatchService, UngatedSymbolDupError, UngatedCooldownError, UngatedSellDirectionError, UngatedLastLossError, UngatedStaleEntryError, UngatedNoQuoteError, UngatedScannerNotAllowedError } from '../../ungated-track/services/ungated-watch.service';
import { UngatedRejectionRepository, UngatedRejectionReason } from '../../ungated-track/repositories/ungated-rejection.repository';
import {
  UngatedCapitalExhaustedError, UngatedPositionCapError, UngatedKillSwitchError,
} from '../../ungated-track/services/ungated-paper-account.service';
import { AdaptiveStopWatchService } from '../../adaptive-stop-track/services/adaptive-stop-watch.service';
import { AnandDualTrackService } from '../../anand-dual-track/services/anand-dual-track.service';
import { BreakoutSwingService } from '../../breakout-swing-track/services/breakout-swing.service';
import {
  SellFuturesService, SellFuturesNoFutureError, SellFuturesSymbolDupError,
  SellFuturesCooldownError, SellFuturesNoQuoteError,
} from '../../sell-futures-track/services/sell-futures.service';
import {
  SellFuturesPositionCapError, SellFuturesMarginExhaustedError, SellFuturesKillSwitchError,
} from '../../sell-futures-track/services/sell-futures-paper-account.service';
import { SellFuturesRejectionRepository, SellFuturesRejectionReason } from '../../sell-futures-track/repositories/sell-futures-rejection.repository';
import { LevelBookService } from '../../signal-generator/services/level-book.service';

interface Hit {
  symbol: string;
  hitPrice: number;
}

/**
 * Outcome kinds that mean "not traded". Each one maps to a pipeline stage for
 * the [trade-rejected] log line. `setup` is the only non-rejection kind, so it
 * never flows through {@link ChartinkProcessService.rejectSetup}.
 *
 * The pipeline is now pure score-based: the three misalignment-veto kinds
 * (`mtf-misaligned`, `macd-misaligned`, `supertrend-misaligned`) are NEVER
 * produced here — misalignment only lowers the 0-100 score — so they are
 * excluded from {@link RejectKind}.
 */
type RejectKind = Exclude<
  CreateAlertSetupInput['kind'],
  'setup' | 'no-setup' | 'sector-misaligned' | 'mtf-misaligned' | 'macd-misaligned' | 'supertrend-misaligned'
>;

const REJECT_STAGE: Record<RejectKind, 'ingest' | 'process' | 'scoring'> = {
  unresolved: 'process',
  'no-direction': 'process',
  'scored-low': 'scoring',
  error: 'scoring',
  // 15:00 IST entry cutoff — rejected before any processing/scoring work.
  'market-closed': 'ingest',
};

const RATE_LIMIT_MS = 350;

@Injectable()
export class ChartinkProcessService {
  private readonly logger = new Logger(ChartinkProcessService.name);

  constructor(
    private readonly repo: ChartinkRepository,
    private readonly mdRepo: MarketDataRepository,
    private readonly scoring: ChartinkScoringService,
    private readonly angelOne: AngelOneAdapterService,
    private readonly nseSector: NseSectorIndexService,
    private readonly watch: WatchService,
    private readonly ungatedWatch: UngatedWatchService,
    private readonly ungatedRejections: UngatedRejectionRepository,
    private readonly adaptiveStopWatch: AdaptiveStopWatchService,
    private readonly anandDualTrack: AnandDualTrackService,
    private readonly breakoutSwing: BreakoutSwingService,
    private readonly sellFutures: SellFuturesService,
    private readonly sellFuturesRejections: SellFuturesRejectionRepository,
    @Optional() private readonly levelBook?: LevelBookService,
  ) {}

  async processAlert(alertId: string, hits: Hit[]): Promise<void> {
    this.logger.log(`Processing Chartink alert ${alertId} — ${hits.length} hits`);
    // Resolve the Chartink scanner name and category once so every [trade-rejected] line
    // can show which scan the stock came from. Best-effort — a lookup failure
    // must not block processing.
    let scanName: string | undefined;
    let scannerCategory: string | undefined;
    try {
      const alert = await this.repo.getAlertWithSetups(alertId);
      scanName = alert?.scanner?.scanName ?? undefined;
      scannerCategory = (alert?.scanner as any)?.category ?? undefined;
    } catch (err) {
      this.logger.warn(
        `could not resolve scanner name for alert ${alertId}: ${err instanceof Error ? err.message : err}`,
      );
    }
    for (let i = 0; i < hits.length; i++) {
      try {
        await this.processOne(alertId, hits[i], scanName, scannerCategory);
      } catch (err) {
        this.logger.warn(
          `processOne unexpected throw for ${hits[i].symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (i < hits.length - 1) await this.sleep(RATE_LIMIT_MS);
    }
  }

  /**
   * Persist a non-tradeable outcome AND emit the shared [trade-rejected] log
   * line so the API terminal explains every stock that did not become a trade.
   * Behaviour of the DB write is identical to a bare `repo.createAlertSetup`
   * call — this only ADDS the console log.
   */
  private async rejectSetup(
    input: CreateAlertSetupInput & { kind: RejectKind; rejectReason: string },
    ctx: { scan?: string; side?: 'BUY' | 'SELL' },
  ): Promise<void> {
    await this.repo.createAlertSetup(input);
    const line = formatTradeRejection({
      symbol: input.symbol,
      stage: REJECT_STAGE[input.kind],
      reason: input.rejectReason,
      scan: ctx.scan,
      hitPrice: input.hitPrice,
      side: ctx.side,
      score: input.score ?? undefined,
    });
    // `error` is an abnormal outcome (scoring threw) — surface it as a warning.
    if (input.kind === 'error') this.logger.warn(line);
    else this.logger.log(line);
  }

  async processOne(alertId: string, hit: Hit, scanName?: string, scannerCategory?: string): Promise<void> {
    // === 0. ENTRY-WINDOW GATE (15:00 IST cutoff) ===
    // No new WATCHING entry may be opened after 15:00 IST (or before 09:15,
    // or on a weekend). Reject BEFORE any symbol resolution / scoring / broker
    // work so a late Chartink alert costs nothing. This gates OPENING only —
    // the rescore loop and every exit path keep running until 15:30 / EOD.
    if (!isWithinEntryWindow()) {
      await this.rejectSetup(
        {
          alertId,
          symbol: hit.symbol,
          token: null,
          hitPrice: hit.hitPrice,
          kind: 'market-closed',
          setupId: null,
          rejectReason: 'outside entry window 09:15-15:00 IST',
        },
        { scan: scanName },
      );
      return;
    }

    // === 1. Resolve symbol ===
    // Chartink sends bare symbols ("LLOYDSENGG"). Our local Instrument
    // table stores them with the NSE series suffix:
    //   -EQ  regular liquid equity (vast majority of liquid stocks)
    //   -BE  trade-to-trade (low-liquidity / surveillance)
    //   -BL  block deal series (sometimes used for ETF tranches)
    //   -IV  insurance / other special series
    // Resolve the symbol directly against Angel's full in-memory scrip master —
    // the WHOLE listed NSE universe — NOT the local `instruments` table, which
    // only ever held a hand-seeded handful of stocks (so NEOGEN and most of the
    // market rejected here as "not in local DB"). Everything downstream needs
    // only the token, so a `{ token }` shape keeps the rest of processOne intact.
    const resolved = await this.angelOne.resolveSymbolToken(hit.symbol, 'NSE');
    if (!resolved) {
      await this.rejectSetup(
        {
          alertId,
          symbol: hit.symbol,
          token: null,
          hitPrice: hit.hitPrice,
          kind: 'unresolved',
          setupId: null,
          rejectReason: `symbol not found in Angel instrument master (NSE)`,
        },
        { scan: scanName },
      );
      return;
    }
    const instrument = { token: resolved.token };

    // === 1b. ANAND DUAL TRACK (intraday 5% + swing 10%) ===
    // Fires IMMEDIATELY after symbol resolution — BEFORE the direction gate and
    // scoring (both of which do slow, rate-paced Angel fetches). This track takes
    // EVERY ANAND_SWING signal with NO score filter and NO direction gate (the
    // two tracks differ only by target/SL), so it must never be starved by the
    // scoring backlog. Dedup guards (active position / already-hit-target-today)
    // live inside createEntries. Independent try/catch: must not block the scored
    // tracks below. (Was previously at the end of processOne, after scoring —
    // which starved it whenever the queue backed up.)
    if (scannerCategory === 'ANAND_SWING') {
      try {
        await this.anandDualTrack.createEntries({
          alertId,
          symbol: hit.symbol,
          token: instrument.token,
          hitPrice: hit.hitPrice,
          scoreBreakdown: null,
        });
      } catch (err) {
        this.logger.warn(
          `[anand-dual-track] createEntries failed for ${hit.symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }

      // Breakout-Swing track — a breakout variant of the swing track. Runs off
      // the SAME ANAND_SWING signals but applies its own near-resistance +
      // above-prev-close gates and a resting limit-buy. Independent try/catch:
      // a reject (the common case) or any failure must never affect the other
      // tracks above.
      try {
        await this.breakoutSwing.createFromAlert({
          alertId,
          symbol: hit.symbol,
          token: instrument.token,
          hitPrice: hit.hitPrice,
          scoreBreakdown: null,
        });
      } catch (err) {
        this.logger.log(
          `[breakout-swing] createFromAlert skipped for ${hit.symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // === 2. DIRECTION GATE (sector trend, with stock-trend fallback) ===
    // We prefer to derive side from the stock's sector index trend. If the
    // sector lookup or its data is unavailable for ANY reason, we fall back
    // to the stock's own 15m trend. Only when BOTH sources are unclear do we
    // skip with 'no-direction'.
    //
    // NseSectorIndexService returns the sector index token directly (e.g. '99926009').
    // Strip any series suffixes since Chartink symbols may arrive bare.
    const symbolBare = hit.symbol.replace(/-EQ$|-BE$|-BL$|-IV$/, '');

    let side: 'BUY' | 'SELL' | null = null;
    let directionSource: 'sector' | 'stock' = 'sector';
    let sectorReason: string | null = null;

    // FIX 2: capture the FULL 15m series the direction gate fetches so the
    // scoring step (checkSectorAligned / checkRelativeStrength / the stock-15m
    // checks) can read them from memory instead of re-fetching the SAME two
    // series from the rate-paced broker.
    const gateCandles = new Map<string, Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>>();

    const sectorToken = await this.nseSector.getSectorIndexForSymbol(symbolBare);
    if (!sectorToken) {
      sectorReason = `no sector mapping for ${symbolBare}`;
    } else {
      const sectorInstrument = await this.mdRepo.getInstrumentByToken(sectorToken);
      if (!sectorInstrument) {
        sectorReason = `sector index token ${sectorToken} not in DB`;
      } else {
        try {
          // Store the sector series under 'NSE' — the exchange the scoring
          // sector checks always query the sector index with — so the key
          // matches regardless of the instrument's recorded exchange.
          const sectorCloses = await this.fetchRecentCloses(
            sectorToken,
            'NSE',
            gateCandles,
          );
          if (sectorCloses.length < 26) {
            sectorReason = `sector ${sectorToken} insufficient candles (${sectorCloses.length})`;
          } else {
            const sectorTrend = classifyTrend(sectorCloses);
            if (sectorTrend === 'UP') side = 'BUY';
            else if (sectorTrend === 'DOWN') side = 'SELL';
            else sectorReason = `sector ${sectorToken} trend ${sectorTrend ?? 'null'}`;
          }
        } catch (err) {
          sectorReason = `sector candle fetch failed: ${err instanceof Error ? err.message : err}`;
        }
      }
    }

    // Fall back to the stock's own 15m trend when the sector gate didn't yield a side.
    let stockReason: string | null = null;
    if (!side) {
      directionSource = 'stock';
      try {
        const stockCloses = await this.fetchRecentCloses(instrument.token, 'NSE', gateCandles);
        if (stockCloses.length >= 26) {
          const stockTrend = classifyTrend(stockCloses);
          if (stockTrend === 'UP') side = 'BUY';
          else if (stockTrend === 'DOWN') side = 'SELL';
          else stockReason = `stock 15m trend ${stockTrend ?? 'null'}`;
        } else {
          stockReason = `stock insufficient candles (${stockCloses.length})`;
        }
      } catch (err) {
        // Don't swallow — capture the failure so the [trade-rejected] line explains it.
        stockReason = `stock candle fetch failed: ${err instanceof Error ? err.message : err}`;
      }
    }

    if (!side) {
      await this.rejectSetup(
        {
          alertId,
          symbol: hit.symbol,
          token: instrument.token,
          hitPrice: hit.hitPrice,
          kind: 'no-direction',
          setupId: null,
          rejectReason: `sector: ${sectorReason ?? 'unknown'}; stock trend also unclear (${stockReason ?? 'unknown'})`,
        },
        { scan: scanName },
      );
      return;
    }

    if (directionSource === 'stock') {
      this.logger.debug(
        `${hit.symbol} side=${side} via stock-trend fallback (sector: ${sectorReason})`,
      );
    }

    // === 3. SCORING ===
    // Build setupContext from the level book so the S/R Room factor has the
    // PDH/PDL/ORH/ORL/VWAP it needs. Best-effort: a missing or stale level
    // book means setupContext stays null, which causes S/R room to log
    // "no level book" (points=0, pointsPossible=0 — no score impact).
    let setupContext: { levelBookSnapshot: { pdh: number; pdl: number; orh: number | null; orl: number | null; vwap: number } } | null = null;
    if (this.levelBook) {
      try {
        const lb = await this.levelBook.lazyLoad(instrument.token, 'NSE', hit.symbol);
        if (lb) {
          setupContext = {
            levelBookSnapshot: {
              pdh: lb.pdh,
              pdl: lb.pdl,
              orh: lb.orh,
              orl: lb.orl,
              vwap: lb.vwap,
            },
          };
        }
      } catch (err) {
        this.logger.debug(
          `[scoring] level book unavailable for ${hit.symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    let scoringResult: Awaited<ReturnType<typeof this.scoring.score>>;
    try {
      scoringResult = await this.scoring.score({
        token: instrument.token,
        symbol: hit.symbol,
        exchange: 'NSE',
        side,
        entryPrice: hit.hitPrice,
        setupContext,
        // FIX 2: serve the stock-15m / sector-15m series the direction gate
        // already fetched from memory; everything else falls through to the
        // broker. Pure data-access dedupe — scores are unchanged.
        candleSource: this.buildGateCandleSource(gateCandles),
      });
    } catch (err) {
      await this.rejectSetup(
        {
          alertId,
          symbol: hit.symbol,
          token: instrument.token,
          hitPrice: hit.hitPrice,
          kind: 'error',
          setupId: null,
          rejectReason: err instanceof Error ? err.message : String(err),
        },
        { scan: scanName, side },
      );
      return;
    }

    // === 4. Persist + Stage 2 trigger ===
    // R3: admission is delegated to the trade policy - score >= 60 normally,
    // but score >= 75 inside the 11:45-14:00 IST window.
    const policy = evaluateTradePolicy({ score: scoringResult.score, at: new Date() });
    if (policy.admitted) {
      const persistedSetup = await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'setup',
        setupId: null,
        rejectReason: null,
        score: scoringResult.score,
        lotCount: scoringResult.lotCount,
        scoreBreakdown: scoringResult.checks,
      });

      // Wire to watch monitor (Stage 2). Failures MUST NOT block setup persistence.
      try {
        await this.watch.createFromAlert({
          alertId,
          setupId: persistedSetup.id,
          symbol: hit.symbol,
          token: instrument.token,
          exchange: 'NSE',
          side,
          initialPrice: hit.hitPrice,
          initialScore: scoringResult.score,
          initialBreakdown: { checks: scoringResult.checks, lotCount: scoringResult.lotCount } as unknown as import('@prisma/client').Prisma.InputJsonValue,
        });
      } catch (err) {
        if (err instanceof WatchCapExceededError) {
          this.logger.warn(`watch cap exceeded - skipping ${hit.symbol}`);
        } else if (err instanceof TradeCooldownError) {
          this.logger.log(`cooldown active - skipping ${hit.symbol}`);
        } else {
          this.logger.warn(
            `watch.createFromAlert failed for ${hit.symbol}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // Adaptive-Stop shadow track — same admitted entry, new vol-stop/risk-first sizing.
      // FIX 3: fire-and-forget. This track does its own live-price fetch + DB
      // writes; awaiting it extended the critical section and head-of-line-
      // blocked the next alert. It runs in the background with its own error
      // handling so it can never affect the gated/ungated paths or the worker
      // that frees up the moment the gated execute completes.
      void this.runAdaptiveStopShadow({
        alertId,
        setupId: persistedSetup.id,
        symbol: hit.symbol,
        token: instrument.token,
        exchange: 'NSE',
        side,
        initialPrice: hit.hitPrice,
        initialScore: scoringResult.score,
        initialBreakdown: { checks: scoringResult.checks, lotCount: scoringResult.lotCount } as any,
      });
    } else {
      await this.rejectSetup(
        {
          alertId,
          symbol: hit.symbol,
          token: instrument.token,
          hitPrice: hit.hitPrice,
          kind: 'scored-low',
          setupId: null,
          rejectReason: policy.reason ?? `score ${scoringResult.score} below ${policy.minScore}`,
          score: scoringResult.score,
          lotCount: scoringResult.lotCount,
          scoreBreakdown: scoringResult.checks,
        },
        { scan: scanName, side },
      );
    }

    // === 5. UNGATED shadow track — runs unconditionally for every scored alert.
    // FIX 3: fire-and-forget. Like the adaptive track it does its own live-
    // price fetch + DB writes; awaiting it head-of-line-blocked the next
    // alert. It runs in the background with its full error handling (including
    // the rejection-record write) preserved inside runUngatedShadow, so
    // failures here still NEVER affect the gated path.
    void this.runUngatedShadow({
      alertId,
      setupId: null,
      symbol: hit.symbol,
      token: instrument.token,
      exchange: 'NSE',
      side,
      initialPrice: hit.hitPrice,
      initialScore: scoringResult.score,
      initialBreakdown: { checks: scoringResult.checks, lotCount: scoringResult.lotCount } as any,
      scannerName: scanName ?? null,
    }, hit.hitPrice);

    // === 6. SELL-FUTURES shadow track — bearish signals only. ===
    // FIX 3 pattern: fire-and-forget. Guarded by side==='SELL' so BUY signals
    // never touch this track. The future is resolved INSIDE the service (gate
    // 1), so the trigger only forwards the equity symbol + side. Its full
    // error handling (rejection-record write) lives in runSellFuturesShadow,
    // so failures here NEVER affect the gated/ungated/adaptive/breakout paths.
    if (side === 'SELL') {
      void this.runSellFuturesShadow({
        alertId,
        setupId: null,
        symbol: hit.symbol,
        token: instrument.token,
        exchange: 'NSE',
        side,
        initialPrice: hit.hitPrice,
        initialScore: scoringResult.score,
        initialBreakdown: { checks: scoringResult.checks, lotCount: scoringResult.lotCount } as any,
        scannerName: scanName ?? null,
      }, hit.hitPrice);
    }

    // (The Anand dual-track formerly ran here, after scoring; it now runs at
    // step 1b above so it's never starved by the scoring backlog.)
  }

  /**
   * Adaptive-Stop shadow track entry, run fire-and-forget (FIX 3). Isolated
   * error handling: a failure is logged and swallowed so it can never affect
   * the gated/ungated paths or block the worker.
   */
  private async runAdaptiveStopShadow(
    input: Parameters<AdaptiveStopWatchService['createFromAlert']>[0],
  ): Promise<void> {
    try {
      await this.adaptiveStopWatch.createFromAlert(input);
    } catch (err) {
      this.logger.warn(`[adaptive-stop] ${input.symbol}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Ungated shadow track entry, run fire-and-forget (FIX 3). Preserves the
   * original error handling: known rejection reasons are recorded to the
   * ungated-rejection repository, everything else is logged.
   */
  private async runUngatedShadow(
    input: Parameters<UngatedWatchService['createFromAlert']>[0],
    hitPrice: number,
  ): Promise<void> {
    try {
      await this.ungatedWatch.createFromAlert(input);
    } catch (err) {
      const reason = this.mapUngatedError(err);
      if (reason) {
        await this.ungatedRejections.record({
          alertId: input.alertId, symbol: input.symbol, reason,
          score: input.initialScore, hitPrice,
        });
      } else {
        this.logger.warn(`[ungated] ${input.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private mapUngatedError(err: unknown): UngatedRejectionReason | null {
    if (err instanceof UngatedScannerNotAllowedError) return 'scanner-not-allowed';
    if (err instanceof UngatedCapitalExhaustedError) return 'capital-exhausted';
    if (err instanceof UngatedPositionCapError) return 'position-cap';
    if (err instanceof UngatedSymbolDupError) return 'symbol-dup';
    if (err instanceof UngatedCooldownError) return 'cooldown';
    if (err instanceof UngatedKillSwitchError) return 'kill-switch';
    if (err instanceof UngatedSellDirectionError) return 'sell-direction';
    if (err instanceof UngatedLastLossError) return 'last-loss';
    if (err instanceof UngatedStaleEntryError) return 'stale-entry';
    if (err instanceof UngatedNoQuoteError) return 'no-quote';
    return null;
  }

  /**
   * SELL-Futures shadow track entry, run fire-and-forget. Mirrors the ungated
   * pattern exactly: known rejection reasons are recorded to the sell-futures
   * rejection repository, everything else is logged. Never throws.
   */
  private async runSellFuturesShadow(
    input: Parameters<SellFuturesService['createFromAlert']>[0],
    hitPrice: number,
  ): Promise<void> {
    try {
      await this.sellFutures.createFromAlert(input);
    } catch (err) {
      const reason = this.mapSellFuturesError(err);
      if (reason) {
        await this.sellFuturesRejections.record({
          alertId: input.alertId, symbol: input.symbol, reason,
          score: input.initialScore, hitPrice,
        });
      } else {
        this.logger.warn(`[sell-futures] ${input.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private mapSellFuturesError(err: unknown): SellFuturesRejectionReason | null {
    if (err instanceof SellFuturesNoFutureError) return 'no-future';
    if (err instanceof SellFuturesSymbolDupError) return 'symbol-dup';
    if (err instanceof SellFuturesCooldownError) return 'cooldown';
    if (err instanceof SellFuturesPositionCapError) return 'position-cap';
    if (err instanceof SellFuturesMarginExhaustedError) return 'margin-exhausted';
    if (err instanceof SellFuturesKillSwitchError) return 'kill-switch';
    if (err instanceof SellFuturesNoQuoteError) return 'no-quote';
    return null;
  }

  /**
   * Fetch the last 50 closes of 15m candles for any token (sector index OR stock).
   * Mirrors ChartinkScoringService.fetch15mCandles — uses getHistoricalData
   * which auto-chunks and rate-paces the Angel One historical API.
   *
   * Side effect (FIX 2): the FULL 15m series fetched here is captured into
   * `gateCandles` (keyed `token:exchange:15m`) so {@link buildGateCandleSource}
   * can hand it to `scoring.score()` and avoid re-fetching the SAME stock-15m
   * and sector-15m series the scoring checks (checkRelativeStrength /
   * checkSectorAligned / etc.) would otherwise pull a second time.
   */
  private async fetchRecentCloses(
    token: string,
    exchange: string,
    gateCandles?: Map<string, Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>>,
  ): Promise<number[]> {
    const to = new Date();
    // 7 days back gives enough bars even accounting for weekends + holidays
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const candles = (await this.angelOne.getHistoricalData(token, exchange, '15m', from, to)) as Array<{
      timestamp: Date | string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;
    if (!candles || candles.length === 0) return [];
    if (gateCandles) {
      // Store the FULL series (forming bar included, chronological) — the
      // scoring candleSource applies its own forming-bar drop + lookback
      // slice, so the result is byte-identical to a fresh broker fetch.
      gateCandles.set(`${token}:${exchange}:15m`, candles.map((c) => ({
        timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume) || 0,
      })));
    }
    // Take last 50 closes (getHistoricalData returns chronological order)
    return candles.slice(-50).map((c) => Number(c.close));
  }

  /**
   * Build a PARTIAL {@link ScoringCandleSource} from the 15m series the
   * direction gate already fetched (FIX 2). Only the series present in
   * `gateCandles` are served from memory; every other series scoring needs
   * (1m/5m/1d, NIFTY-15m, and — when not covered here — sector-15m) falls
   * through to the rate-paced broker fetch via the `has()` predicate. This is
   * a pure data-access dedupe: scores/checks are identical to a live fetch of
   * the same candles.
   */
  private buildGateCandleSource(
    gateCandles: Map<string, Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>>,
  ): ScoringCandleSource | undefined {
    if (gateCandles.size === 0) return undefined;
    return {
      has: (token, exchange, tf) => gateCandles.has(`${token}:${exchange}:${tf}`),
      getCandles: (token, exchange, tf, asOf) => {
        const series = gateCandles.get(`${token}:${exchange}:${tf}`);
        if (!series) return [];
        const cutoff = asOf.getTime();
        return series.filter((c) => c.timestamp.getTime() <= cutoff);
      },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
