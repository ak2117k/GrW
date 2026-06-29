import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { Prisma, WatchEntry, WatchEventType, WatchStatus } from '@prisma/client';
import { WatchRepository } from '../repositories/watch.repository';
import { TargetCalculatorService, LevelBookSnapshot } from './target-calculator.service';
import { StrikeSelectorService } from './strike-selector.service';
import { MarketFeedService, BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { BrokerAdapter } from '../../../common/interfaces/broker-adapter.interface';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { WatchGateway } from '../gateways/watch.gateway';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { DEFAULT_MAX_CAPITAL_PER_TRADE } from '@td/shared';
import { formatTradeRejection } from '../../../common/utils/trade-rejection-log';
import { isWithinEntryWindow } from '../../../common/utils/market-hours';
import { evaluateTradePolicy } from './trade-policy';
import { evaluateLossReentry } from './loss-reentry';

export const WATCH_CAP = 50;

/** Partial-exit trigger: when |price move from entry| in our direction >= this %.
 *  Revised from 0.10 → 0.01 for realistic intraday scalping. */
const PARTIAL_EXIT_THRESHOLD_PCT = 0.01;

/** Trailing stop distance: stop tracks the most-favorable price minus/plus this %.
 *  Revised from 0.02 → 0.005 — tighter trail prevents giving back the 1% gain. */
const TRAILING_STOP_PCT = 0.005;

/** Hard price stop threshold: 0.4% of entry price (same rate as hardLossCutRupees). */
const HARD_STOP_PCT = 0.004;

/** Upside (chase) gate: refuse to fill only when the stock has already run more
 *  than this far above the alert price by the time we execute.
 *  Widened 0.01 → 0.03 on forward evidence (tmp-missed-analysis): the old 1%
 *  gate blocked 42 entries of which 93% went on to hit target with avg max-
 *  adverse ~0% — prior intraday strength is a POSITIVE predictor for this
 *  momentum strategy, so the gate was filtering out our best winners. 3% keeps
 *  a backstop against genuine runaway gaps while admitting the 1–3% drift. */
const MAX_CHASE_PCT = 0.03;

/** Live-quote fetch retries on the execute path. A transient Angel feed/REST
 *  blip used to permanently miss the trade (single fetch fails → refuse → drift
 *  to MISSED). Retry a few times with a brief backoff before refusing. ~1.2s
 *  worst case on the background auto-execute worker, so it never blocks intake. */
const QUOTE_FETCH_ATTEMPTS = 3;
const QUOTE_RETRY_MS = 400;

/** Fraction of position to exit at the partial-exit threshold. (Unchanged.) */
const PARTIAL_EXIT_FRACTION = 0.5;

/** Legacy fallback loss-cut threshold (₹1000). Used by hardLossCutRupees()
 *  only for entries with no quantity. The live per-entry threshold is 0.4% of
 *  deployed capital, computed by hardLossCutRupees(entry). */
export const HARD_LOSS_CUT_RUPEES = 1000;

/**
 * Hard price loss-cut threshold for a trade (R5): 0.4% of the deployed
 * capital (quantity x executedPrice). Replaces the flat HARD_LOSS_CUT_RUPEES,
 * which now only serves as the fallback for legacy entries with no `quantity`.
 */
export function hardLossCutRupees(entry: {
  quantity?: number | null;
  executedPrice?: number | null;
  initialPrice?: number | null;
}): number {
  const qty = entry.quantity ?? 0;
  const price = entry.executedPrice ?? entry.initialPrice ?? 0;
  const deployed = qty * price;
  return deployed > 0 ? 0.004 * deployed : HARD_LOSS_CUT_RUPEES;
}

/** LEGACY FALLBACK per-trade capital cap. No longer drives live order sizing —
 *  that is now the score-tiered capital from `evaluateTradePolicy` (R4).
 *  This constant is retained only as the fallback in `computeOpenPnl` and
 *  `checkPartialExitTrigger` when an entry has no persisted `quantity`.
 *  Sourced from the shared risk cap (DEFAULT_MAX_CAPITAL_PER_TRADE) so the
 *  fallback remains consistent with the RiskManager's hard limit. */
export const MAX_INVESTMENT_PER_TRADE = DEFAULT_MAX_CAPITAL_PER_TRADE;

export class WatchCapExceededError extends Error {
  constructor(activeCount: number) {
    super(`Watch entry cap exceeded: ${activeCount}/${WATCH_CAP} active`);
    this.name = 'WatchCapExceededError';
  }
}

/** Re-entry cooldown window (R2): no new trade for a symbol within this many
 *  ms of its last execution. */
export const TRADE_COOLDOWN_MS = 45 * 60_000;

export class TradeCooldownError extends Error {
  constructor(symbol: string) {
    super(`${symbol}: traded within the last 45 minutes - cooldown active`);
    this.name = 'TradeCooldownError';
  }
}

export class TradeSellDirectionError extends Error {
  constructor(symbol: string) {
    super(`${symbol}: side=SELL rejected — watch track is BUY-only`);
    this.name = 'TradeSellDirectionError';
  }
}

export class TradeLastLossError extends Error {
  constructor(symbol: string, pnl: number) {
    super(`${symbol}: last closed trade was a loss (₹${pnl.toFixed(0)}) — entry blocked until a winning trade clears it`);
    this.name = 'TradeLastLossError';
  }
}

export class TradeStaleEntryError extends Error {
  constructor(symbol: string, dynamicRR: number) {
    super(`${symbol}: stale entry — dynamic R:R ${dynamicRR.toFixed(2)} below minimum; move already consumed`);
    this.name = 'TradeStaleEntryError';
  }
}

export interface CreateFromAlertInput {
  alertId: string;
  setupId: string;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
}

@Injectable()
export class WatchService {
  private readonly logger = new Logger(WatchService.name);

  /** A WS-cached tick is "fresh" enough to fill against if it arrived within
   *  this window. Matches ExitPriceService.FRESH_WINDOW_MS (2 min) so the
   *  fill-side and exit-side fresh-price policies agree. */
  private static readonly WS_FRESH_WINDOW_MS = 120_000;

  constructor(
    private readonly repo: WatchRepository,
    private readonly target: TargetCalculatorService,
    private readonly strike: StrikeSelectorService,
    private readonly feed: MarketFeedService,
    private readonly levelBook: LevelBookService,
    private readonly gateway: WatchGateway,
    private readonly trade: TradeExecutionService,
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null = null,
  ) {}

  /**
   * List watch entries (optionally a single IST day) enriched with the
   * triggering Chartink scanner name and, for closed entries, the linked
   * trade's realized P/L.
   */
  async list(opts: { status?: WatchStatus; date?: string }): Promise<
    Array<
      WatchEntry & {
        scannerName: string | null;
        realizedPnl: number | null;
        /**
         * Round-trip SEBI/exchange/brokerage charges for the linked trade.
         * Null when the entry has no realized pnl (trade still open, or
         * the linked Trade row could not be resolved). The watch page's
         * footer sums these to surface the structural charge drag on
         * intraday equity P&L.
         */
        realizedFees: number | null;
      }
    >
  > {
    const entries = await this.repo.list(opts);
    const alertIds = entries
      .map((e) => e.alertId)
      .filter((x): x is string => !!x);
    const tradeIds = entries
      .map((e) => e.paperTradeId ?? e.liveTradeId)
      .filter((x): x is string => !!x);
    const [scannerNames, realization] = await Promise.all([
      this.repo.findScannerNames(alertIds),
      this.repo.findTradeRealization(tradeIds),
    ]);
    return entries.map((e) => {
      const tradeId = e.paperTradeId ?? e.liveTradeId;
      const r = tradeId ? realization.get(tradeId) : undefined;
      return {
        ...e,
        scannerName: e.alertId ? scannerNames.get(e.alertId) ?? null : null,
        realizedPnl: r?.pnl ?? null,
        realizedFees: r?.fees ?? null,
      };
    });
  }

  async createFromAlert(input: CreateFromAlertInput): Promise<WatchEntry> {
    // BUY-only gate — watch track trades equities long only.
    if (input.side !== 'BUY') {
      this.logger.warn(
        formatTradeRejection({
          symbol: input.symbol,
          side: input.side,
          stage: 'watch',
          reason: 'side=SELL rejected — watch track is BUY-only',
        }),
      );
      throw new TradeSellDirectionError(input.symbol);
    }

    // Tier 1 dedup: same Chartink setup (retries / Bull job replays).
    const existingBySetup = await this.repo.findActiveBySetupId(input.setupId);
    if (existingBySetup) {
      this.logger.debug(
        `createFromAlert: returning existing entry ${existingBySetup.id} for setup ${input.setupId}`,
      );
      return existingBySetup;
    }

    // Tier 2 dedup: same STOCK already has an active watch entry. Without
    // this, a stock that fires across multiple Chartink scanners in the same
    // session creates duplicate WatchEntry rows — wasteful, confusing on the
    // /watch UI, and inflates the 50-slot cap counter. We keep the FIRST
    // entry and reuse it; subsequent fires return the existing one.
    const existingByToken = await this.repo.findActiveByToken(input.token);
    if (existingByToken.length > 0) {
      const reused = existingByToken[0];
      this.logger.log(
        `createFromAlert: ${input.symbol} already being watched (entry ${reused.id}, status=${reused.status}) — skipping duplicate from setup ${input.setupId}`,
      );
      return reused;
    }

    // R2: 45-minute re-entry cooldown. A symbol executed in the last 45 min
    // may not be re-traded even though its prior trade has already closed
    // (which is why the active-token dedup above did not catch it).
    const cooldownSince = new Date(Date.now() - TRADE_COOLDOWN_MS);
    if (await this.repo.wasTokenExecutedSince(input.token, cooldownSince)) {
      this.logger.warn(
        formatTradeRejection({
          symbol: input.symbol,
          side: input.side,
          stage: 'watch',
          reason: 'symbol traded within the last 45 min - cooldown active',
        }),
      );
      throw new TradeCooldownError(input.symbol);
    }

    // Re-entry gate. After a same-day loss the symbol is normally locked out,
    // but a smart loss-recovery re-entry is admitted on overwhelming proof the
    // uptrend resumed: score>80 + the four momentum factors pass + price has
    // reclaimed the prior entry, capped at one half-size recovery per day. A
    // green close (pnl>0) re-enters normally. Same-day only — yesterday's loss
    // does not carry over.
    const todayIst = new Date(
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00.000+05:30',
    );
    let recoveryReEntry = false;
    const lastClosed = await this.repo.getLastClosedTradeForToken(input.token, todayIst);
    if (lastClosed !== null && lastClosed.pnl <= 0) {
      const bd = input.initialBreakdown as unknown;
      const checks: Array<{ name: string; passed: boolean }> = Array.isArray(bd)
        ? (bd as Array<{ name: string; passed: boolean }>)
        : Array.isArray((bd as { checks?: unknown })?.checks)
          ? ((bd as { checks: Array<{ name: string; passed: boolean }> }).checks)
          : [];
      const verdict = evaluateLossReentry({
        score: input.initialScore,
        breakdown: checks,
        // The alert's trigger price is the price prompting this re-entry — the
        // scanner just fired on it — so it IS the "live, else alert price" value.
        currentPrice: input.initialPrice,
        priorEntryPrice: lastClosed.entryPrice,
        priorRecoveryCount: await this.repo.countRecoveryReentriesToday(input.token, todayIst),
      });
      if (!verdict.allow) {
        this.logger.warn(
          formatTradeRejection({
            symbol: input.symbol,
            side: input.side,
            stage: 'watch',
            reason: `loss re-entry blocked: ${verdict.reason} (last pnl ₹${lastClosed.pnl.toFixed(0)})`,
          }),
        );
        throw new TradeLastLossError(input.symbol, lastClosed.pnl);
      }
      recoveryReEntry = true;
      this.logger.log(
        `[watch] ${input.symbol}: loss-recovery re-entry admitted at half size — ${verdict.reason}`,
      );
    }

    const active = await this.repo.countActive();
    if (active >= WATCH_CAP) {
      this.logger.warn(
        formatTradeRejection({
          symbol: input.symbol,
          side: input.side,
          stage: 'watch',
          reason: `Watch entry cap exceeded: ${active}/${WATCH_CAP} active`,
        }),
      );
      throw new WatchCapExceededError(active);
    }

    const lb = this.safeLevelBook(input.token);
    const targetResult = this.target.compute({
      side: input.side,
      entryPrice: input.initialPrice,
      levelBook: lb,
    });

    const picked = await this.safePickStrike(input);

    const entry = await this.repo.createEntry({
      alertId: input.alertId,
      setupId: input.setupId,
      symbol: input.symbol,
      token: input.token,
      exchange: input.exchange,
      side: input.side,
      initialPrice: input.initialPrice,
      initialScore: input.initialScore,
      initialBreakdown: input.initialBreakdown,
      profitTarget: targetResult.target,
      profitTargetSource: targetResult.source,
      // Score-decay stop fires when a re-score drops below this floor. Kept
      // below the 47 entry-admission floor so a trade admitted at 47-49 is
      // not dead-on-arrival — the stop only fires on genuine decay under 45.
      stopLossScore: 45,
      recoveryReEntry,
      optionsToken: picked?.optionsToken ?? null,
      optionsType: picked?.optionsType ?? null,
      optionsExpiry: picked?.optionsExpiry ?? null,
      optionsStrike: picked?.optionsStrike ?? null,
      optionsLotSize: picked?.optionsLotSize ?? null,
      optionsSelectionScore: picked?.optionsSelectionScore ?? null,
    });

    await this.repo.createEvent({
      watchEntryId: entry.id,
      eventType: WatchEventType.INITIAL,
      price: input.initialPrice,
      score: input.initialScore,
      breakdown: input.initialBreakdown,
      priceDelta: null,
      scoreDelta: null,
      notes: targetResult.source === 'fallback-2pct' ? 'pt:fallback-2pct' : null,
    });

    this.logger.log(
      `Watch created: ${entry.symbol} ${entry.side} score=${input.initialScore} target=${targetResult.target} (${targetResult.source})`,
    );

    // Auto-execute: criteria is already met (score≥50, sector gate passed,
    // MTF aligned, dedup OK), so place the paper trade immediately and let
    // the watch-monitor manage the lifecycle (partial exit, trailing stop,
    // score-decay SL, EOD square-off).
    //
    // Failures (insufficient cash, market closed, daily loss breaker) are
    // caught and logged — the entry remains WATCHING so the user can retry
    // manually from the UI. We never roll back the WatchEntry, since the
    // scoring decision and dedup state are valuable journal data even when
    // the broker call fails.
    try {
      const traded = await this.executeEntry(entry.id, { mode: 'paper' });
      // `traded` is null when a gate (upside/entry-window/no-quote) declined the
      // entry — it already journaled the real reason. Use optional chaining so a
      // null return does not throw `Cannot read properties of null (reading
      // 'entryPrice')`, which was being caught below and journaled as a second,
      // masking "auto-execute failed" NOT_TRADED event that hid the true gate.
      this.logger.log(
        `Auto-executed paper trade for ${entry.symbol} @ ₹${(traded as any)?.entryPrice ?? input.initialPrice}`,
      );
      // Re-fetch so the caller sees TRADED status (not the stale WATCHING).
      const updated = await this.repo.findById(entry.id);
      return updated ?? entry;
    } catch (err) {
      this.logger.warn(
        formatTradeRejection({
          symbol: entry.symbol ?? input.symbol,
          side: entry.side ?? input.side,
          stage: 'execution',
          reason: `Auto-execute failed (entry stays WATCHING for manual retry): ${err instanceof Error ? err.message : err}`,
        }),
      );
      await this.recordNotTraded(
        entry.id,
        `auto-execute failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return entry;
    } finally {
      // Subscribe to the live feed only now — AFTER the execute step has
      // resolved. Subscribing earlier (Bug B) let a tick land while the
      // entry was still WATCHING, so applyTick skipped the price loss-cut
      // (it is gated `status === 'TRADED'`). Runs on both paths: a TRADED
      // entry needs ticks for its exits, and a still-WATCHING entry (auto-
      // execute failed) needs them so the rescore loop has a live price.
      this.feed.subscribeForWatch(entry.token, entry.id);
      if (picked?.optionsToken) {
        this.feed.subscribeForWatch(picked.optionsToken, entry.id);
      }
    }
  }

  /**
   * Place the broker order for a WATCHING entry and transition it to TRADED.
   * Called both manually (POST /api/watch/:id/execute) and automatically
   * (right after createFromAlert succeeds in paper mode). All RiskManager
   * checks run inside trade.executeTrade — insufficient cash, daily-loss
   * breaker, market-hours gate, duplicate-position guard, kill switch.
   *
   * Quantity selection:
   *   - F&O leg present → lotCount × optionsLotSize
   *   - Equity intraday → floor(score-tiered capital / referencePrice)
   *     (capital from `evaluateTradePolicy`)
   * Caller can override with `quantityOverride`. Reference price prefers
   * the live currentPrice over the initial fire price so we size against
   * what we'll actually pay.
   */
  async executeEntry(
    entryId: string,
    options: { mode?: 'paper' | 'live'; quantityOverride?: number; force?: boolean } = {},
  ): Promise<any> {
    const mode = options.mode ?? 'paper';
    const entry = await this.repo.findById(entryId);
    if (!entry) throw new Error(`WatchEntry ${entryId} not found`);
    if (entry.status !== WatchStatus.WATCHING) {
      throw new Error(`Cannot execute on entry in status ${entry.status}`);
    }

    // 15:00 IST entry cutoff — defensive gate for the manual-execute path
    // (POST /watch/:id/execute) and a backstop for auto-execute. No NEW
    // position may be opened after 15:00 IST. We do NOT throw and we do NOT
    // change status — the entry stays WATCHING (same outcome as a failed
    // auto-execute) so existing rescore/exit handling is untouched. Open
    // positions are still managed and squared off normally by the rescore
    // loop and the exit paths, which run on their own 15:30/EOD schedule.
    if (!isWithinEntryWindow()) {
      this.logger.warn(
        formatTradeRejection({
          symbol: entry.symbol,
          side: entry.side ?? undefined,
          stage: 'execution',
          reason: 'outside entry window 09:15-15:00 IST — entry stays WATCHING',
        }),
      );
      await this.recordNotTraded(entryId, 'outside entry window 09:15-15:00 IST');
      return null;
    }

    const optionsLotSize = (entry as any).optionsLotSize ?? null;
    const lotCount = (entry.initialBreakdown as any)?.lotCount ?? 1;

    // Bug A: never fill at the (possibly stale) Chartink trigger price stored
    // as initialPrice. For an equity entry, price the order off a fresh live
    // quote; if no live price can be obtained, refuse to trade — opening a
    // position at an unverified price births it already mispriced. Options
    // legs keep their existing reference (option pricing is out of scope).
    let referencePrice: number;
    if (optionsLotSize) {
      referencePrice = (entry as any).currentPrice ?? entry.initialPrice;
    } else {
      const livePrice = await this.fetchLivePrice(entry);
      const resolved = livePrice ?? (entry as any).currentPrice ?? null;
      if (resolved == null || resolved <= 0) {
        this.logger.warn(
          formatTradeRejection({
            symbol: entry.symbol,
            side: entry.side ?? undefined,
            stage: 'execution',
            reason:
              'no live quote available — refusing to fill at the stale alert price; entry stays WATCHING',
          }),
        );
        await this.recordNotTraded(entryId, 'no live quote available — refused to fill at the stale alert price');
        return null;
      }
      referencePrice = resolved;
    }

    // Upside (chase) gate (equity only): block only when the stock has already
    // run more than MAX_CHASE_PCT above the Chartink alert price before we can
    // execute. This still refuses genuine runaway gaps while admitting normal
    // intraday momentum drift — forward evidence showed a tight 1% gate was
    // filtering out the strongest movers (93% of which hit target). See the
    // MAX_CHASE_PCT comment for the data.
    // `force: true` bypasses this gate for manual overrides.
    if (!optionsLotSize && !options.force) {
      const alertPrice = (entry.initialPrice ?? referencePrice);
      const moveFromAlert = alertPrice > 0 ? (referencePrice - alertPrice) / alertPrice : 0;
      if (moveFromAlert > MAX_CHASE_PCT) {
        this.logger.warn(
          formatTradeRejection({
            symbol: entry.symbol,
            side: entry.side ?? undefined,
            stage: 'execution',
            reason: `stale entry — already moved +${(moveFromAlert * 100).toFixed(2)}% from alert price ₹${alertPrice.toFixed(2)} (live ₹${referencePrice.toFixed(2)}) — entry stays WATCHING`,
          }),
        );
        await this.recordNotTraded(
          entryId,
          `already moved +${(moveFromAlert * 100).toFixed(2)}% from alert ₹${alertPrice.toFixed(2)} (live ₹${referencePrice.toFixed(2)}) before we could fill — chasing refused`,
        );
        return null;
      }
    }

    // R4: equity quantity is sized off the score-tiered capital, not a flat
    // 2L. evaluateTradePolicy always returns a valid capital; admission was
    // already decided upstream in ChartinkProcessService.processOne.
    // A loss-recovery re-entry already failed once today — deploy HALF the
    // normal score-tier size on the second attempt.
    const recoveryHalf = (entry as { recoveryReEntry?: boolean }).recoveryReEntry === true;
    const tradeCapital =
      evaluateTradePolicy({ score: entry.initialScore, at: new Date() }).capital *
      (recoveryHalf ? 0.5 : 1);
    const effectiveLots = recoveryHalf ? Math.max(1, Math.floor(lotCount / 2)) : lotCount;
    const computedQty = optionsLotSize
      ? effectiveLots * optionsLotSize
      : Math.max(1, Math.floor(tradeCapital / Math.max(referencePrice, 1)));
    const qty = options.quantityOverride ?? computedQty;

    const trade = await this.trade.executeTrade({
      symbol: (entry as any).optionsToken ? (entry as any).optionsToken : entry.symbol,
      // Equity fallback must be the numeric instrument token (entry.token),
      // not the symbol — findInstrumentId resolves NSE cash by token.
      token: (entry as any).optionsToken ?? entry.token,
      exchange: (entry as any).exchange ?? 'NSE',
      side: entry.side as any,
      quantity: qty,
      orderType: 'MARKET' as any,
      positionType: 'INTRADAY' as any,
      // Pass referencePrice so the RiskManager's paper-cash check can
      // estimate orderValue on MARKET orders (which otherwise have no
      // price field).
      price: referencePrice,
      stoploss: (entry as any).stopLoss ?? undefined,
      target: (entry as any).profitTarget ?? undefined,
      source: 'WATCH',
    } as any);

    const actualEntryPrice =
      (trade as any).entryPrice ??
      (entry as any).currentPrice ??
      (entry as any).initialPrice;

    const updateData: Prisma.WatchEntryUpdateInput = {
      status: WatchStatus.TRADED,
      executedAt: new Date(),
      executedPrice: actualEntryPrice,
      // The REAL filled quantity — so P&L is computed from the actual position
      // size, never reconstructed as floor(MAX_INVESTMENT_PER_TRADE / price).
      quantity: (trade as any).quantity ?? qty,
      paperTradeId: mode === 'paper' ? (trade as any).id : null,
      liveTradeId: mode === 'live' ? (trade as any).id : null,
    };

    // Re-anchor the profit target to the ACTUAL fill price. createFromAlert
    // computed it from the Chartink alert price, but the live fill (the Bug A
    // fix above) can differ — the stock moves between alert and execution —
    // which would leave the target the wrong distance from the real entry, so
    // it "hits" on noise within seconds for a near-zero / negative P&L.
    // Equity only — an options leg's target tracking is out of scope here.
    if (!optionsLotSize && actualEntryPrice > 0) {
      const retarget = this.target.compute({
        side: entry.side as 'BUY' | 'SELL',
        entryPrice: actualEntryPrice,
        levelBook: this.safeLevelBook(entry.token),
      });
      updateData.profitTarget = retarget.target;
      updateData.profitTargetSource = retarget.source;
    }

    await this.repo.update(entryId, updateData);

    return trade;
  }

  /**
   * Fetch a fresh live LTP for an equity entry. Returns null when no source
   * yields a usable price — the caller then refuses to execute rather than
   * trading at the stale stored alert price.
   *
   * FIX 4: prefer the WS-cached LTP first. The persistent feed already streams
   * a tick for the held token in most cases, so a fresh cached quote spares us
   * a blocking REST round-trip on the alert→order critical path. We only fall
   * through to the REST `getLiveQuote` when no FRESH cached tick exists.
   */
  private async fetchLivePrice(entry: WatchEntry): Promise<number | null> {
    // 1) Fresh WS-cached tick (no network round-trip).
    const cachedLtp = this.freshCachedLtp(entry.token);
    if (cachedLtp != null) return cachedLtp;

    // 2) Fall back to a blocking REST quote, retried a few times. A transient
    //    Angel feed/REST blip (or a momentarily-empty quote) shouldn't refuse
    //    the fill and permanently miss the trade — give it a few brief retries.
    if (!this.brokerAdapter) return null;
    for (let attempt = 1; attempt <= QUOTE_FETCH_ATTEMPTS; attempt++) {
      try {
        const tick = await this.brokerAdapter.getLiveQuote(
          entry.token,
          (entry as any).exchange ?? 'NSE',
        );
        const ltp = (tick as any)?.ltp;
        if (typeof ltp === 'number' && ltp > 0) return ltp;
      } catch (err) {
        this.logger.warn(
          `fetchLivePrice(${entry.symbol}) attempt ${attempt}/${QUOTE_FETCH_ATTEMPTS} failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
      if (attempt < QUOTE_FETCH_ATTEMPTS) await this.delay(QUOTE_RETRY_MS);
    }
    return null;
  }

  /** Small awaitable backoff. A method (not an inline setTimeout) so tests can
   *  stub it to resolve immediately and not wait on real/fake timers. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Return the feed's cached LTP for a token IFF a tick arrived within
   * {@link WatchService.WS_FRESH_WINDOW_MS}. Returns null when the feed has no
   * `getQuote` accessor, holds no tick, the tick is stale, or the LTP is
   * non-positive — every such case defers to the REST fallback above. Mirrors
   * the 2-minute fresh window the ExitPriceService uses for the same purpose.
   */
  private freshCachedLtp(token: string): number | null {
    const getQuote = (this.feed as { getQuote?: (t: string) => { ltp?: number; timestamp?: Date | string } | null })?.getQuote;
    if (typeof getQuote !== 'function') return null;
    const quote = getQuote.call(this.feed, token);
    if (!quote) return null;
    const ltp = quote.ltp;
    if (typeof ltp !== 'number' || ltp <= 0) return null;
    const ts = quote.timestamp instanceof Date ? quote.timestamp : (quote.timestamp ? new Date(quote.timestamp) : null);
    if (!ts || Number.isNaN(ts.getTime())) return null;
    const age = Date.now() - ts.getTime();
    if (age < 0 || age > WatchService.WS_FRESH_WINDOW_MS) return null;
    return ltp;
  }

  /**
   * Retrieves the level book for a token using LevelBookService.getLevels()
   * (synchronous, in-memory lookup). Returns null when the book is not yet
   * seeded. TargetCalculator falls back to 10% when null is passed.
   *
   * NOTE: The planned spec used getSnapshot() which doesn't exist on
   * LevelBookService. We use getLevels() instead (the real sync API).
   * vwapStddev is not part of the LevelBook type, so it's normalized to 0.
   */
  private safeLevelBook(token: string): LevelBookSnapshot | null {
    try {
      const snap = this.levelBook.getLevels(token);
      if (!snap) return null;
      return {
        pdh: snap.pdh,
        pdl: snap.pdl,
        orh: snap.orh ?? null,
        orl: snap.orl ?? null,
        vwap: snap.vwap,
        // LevelBook does not expose vwapStddev; normalize to 0 so
        // TargetCalculator can still compute VWAP ± σ candidates.
        vwapStddev: (snap as any).vwapStddev ?? 0,
      };
    } catch (err) {
      this.logger.warn(`safeLevelBook(${token}) failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async safePickStrike(input: CreateFromAlertInput) {
    try {
      return await this.strike.pick({
        symbol: input.symbol.replace(/-EQ$|-BE$|-BL$|-IV$/, ''),
        side: input.side,
        underlyingPrice: input.initialPrice,
      });
    } catch (err) {
      this.logger.warn(`safePickStrike(${input.symbol}) failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // ============================================
  // State transitions
  // ============================================

  private static readonly MATERIAL_CHANGE_PCT = 0.0025;

  /**
   * Out-of-order guard tolerance. The `lastTickAt` guard in onTick drops a
   * tick whose timestamp is older than the last one processed — but only
   * trusts the broker-supplied timestamp when it is itself plausibly fresh
   * (within this window of wall-clock). A broker that emits a stale or
   * non-advancing timestamp (observed in production: an illiquid token
   * frozen at a pre-market time) would otherwise wedge the entry forever,
   * silently disabling the price-based loss-cut that lives in applyTick.
   */
  private static readonly STALE_BROKER_TICK_MS = 60_000;

  /**
   * Called by WatchMonitorWorker on each market tick for a watched token.
   * Drops out-of-order ticks, updates MFE/MAE watermarks, checks target
   * and material price-change thresholds, and triggers state transitions.
   */
  async onTick(token: string, ltp: number, timestamp: Date): Promise<void> {
    const entries = await this.findActiveByToken(token);
    // Only trust the broker tick timestamp for ordering when it is close to
    // wall-clock. If it is stale (or in the future), fall back to arrival
    // time — monotonic, and so unable to permanently wedge the entry.
    const now = new Date();
    const brokerClockTrustworthy =
      Math.abs(now.getTime() - timestamp.getTime()) <
      WatchService.STALE_BROKER_TICK_MS;
    const effectiveTs = brokerClockTrustworthy ? timestamp : now;
    for (const entry of entries) {
      if (entry.lastTickAt && effectiveTs <= entry.lastTickAt) continue;
      await this.applyTick(entry, ltp, effectiveTs);
    }
  }

  private async findActiveByToken(token: string) {
    return this.repo.findActiveByToken(token);
  }

  private async applyTick(entry: any, ltp: number, timestamp: Date): Promise<void> {
    const side = entry.side as 'BUY' | 'SELL';

    const maxFavorable = side === 'BUY'
      ? Math.max(entry.maxFavorable ?? entry.initialPrice, ltp)
      : Math.min(entry.maxFavorable ?? entry.initialPrice, ltp);
    const maxAdverse = side === 'BUY'
      ? Math.min(entry.maxAdverse ?? entry.initialPrice, ltp)
      : Math.max(entry.maxAdverse ?? entry.initialPrice, ltp);

    await this.repo.update(entry.id, {
      currentPrice: ltp,
      lastTickAt: timestamp,
      maxFavorable,
      maxAdverse,
    });

    this.gateway.emitTick(entry.id, { price: ltp, currentScore: entry.currentScore ?? null });
    // Push the full row so the frontend can merge in place without a
    // refetch — replaces the "tick → refetch list" hop and the visible
    // table flash that came with it. Read the freshest row so it
    // includes the currentPrice/maxFavorable/maxAdverse we just wrote.
    this.repo.findById(entry.id).then((fresh) => {
      if (fresh) this.gateway.emitEntry(fresh);
    }).catch(() => {});

    const isTargetHit = side === 'BUY'
      ? ltp >= entry.profitTarget
      : ltp <= entry.profitTarget;
    if (isTargetHit) {
      // Only a TRADED position can record a real TARGET_HIT win. An un-executed
      // entry (still WATCHING — e.g. the upside gate refused to chase a price
      // that already ran past the alert) that drifts to its target is NOT a
      // trade we took: mark it MISSED rather than a phantom TARGET_HIT, so it
      // never books a win or pollutes the P&L total.
      if (entry.status === WatchStatus.TRADED) {
        await this.transitionTargetHit(entry.id, ltp);
      } else {
        await this.transitionMissed(entry.id, ltp);
      }
      return;
    }

    // Hard loss-cut: any TRADED entry whose open loss reaches the threshold is
    // cut. This is a price-based stop — a real, hard fact — so it fires
    // regardless of the 10-minute score-decay grace window, and before the
    // partial-exit / trailing-stop logic so a loss is never left to ride.
    // Only the target-hit check above is allowed to win first (a profit exit).
    //
    // Two-strike stop-hunt guard: require 2 consecutive ticks below the SL
    // threshold before exiting. A single bad WS tick or a brief stop-hunt
    // spike must not cut the position — genuine breakdowns stay broken for
    // at least 2 ticks, so the cost of waiting is negligible vs. the benefit
    // of avoiding a false exit on noise.
    if (entry.status === 'TRADED') {
      const openPnl = this.computeOpenPnl(entry, ltp);
      if (openPnl <= -hardLossCutRupees(entry)) {
        const currentBreachCount: number = (entry as any).slBreachCount ?? 0;
        if (currentBreachCount < 1) {
          // First breach — increment counter, do NOT exit yet.
          this.logger.warn(
            `[watch] ${entry.symbol}: first SL breach (stop-hunt guard) — ltp=${ltp} ` +
            `loss=₹${Math.abs(openPnl).toFixed(0)}, awaiting confirmation on next tick`,
          );
          await this.repo.update(entry.id, { slBreachCount: currentBreachCount + 1 } as any);
          return;
        }
        // Second consecutive breach — confirmed breakdown, exit.
        await this.transitionLossCut(entry.id, ltp, openPnl);
        return;
      }
      // Price is ABOVE the SL level — reset breach counter if it was non-zero.
      if ((entry as any).slBreachCount > 0) {
        this.logger.log(
          `[watch] ${entry.symbol}: SL breach count reset (price recovered above SL, ltp=${ltp})`,
        );
        await this.repo.update(entry.id, { slBreachCount: 0 } as any);
      }
    }

    // Partial-exit + trailing-stop apply ONLY to TRADED equity entries.
    // Options positions skip this (50% of a lot is fractional). The
    // existing target-hit check above is allowed to fire first — if
    // profitTarget < +10%, the entry closes at target with no partial exit.
    const isEquityTraded = entry.status === 'TRADED' && !entry.optionsToken;
    if (isEquityTraded) {
      if (!entry.partialExitedAt) {
        // Phase 1: haven't done partial exit yet. Check if we've hit +10% threshold.
        await this.checkPartialExitTrigger(entry, ltp);
      } else {
        // Phase 2: already did partial exit. Update trailing high-water and
        // check trailing stop.
        await this.updateTrailingStop(entry, ltp);
      }
    }

    const last = entry.lastEventPrice ?? entry.initialPrice;
    const delta = (ltp - last) / last;
    if (Math.abs(delta) >= WatchService.MATERIAL_CHANGE_PCT) {
      await this.repo.createEvent({
        watchEntryId: entry.id,
        eventType: WatchEventType.PRICE_CHANGE,
        price: ltp,
        priceDelta: delta * 100,
        score: null,
        breakdown: null,
      });
      await this.repo.update(entry.id, { lastEventPrice: ltp });
    }
  }

  async transitionTargetHit(entryId: string, price: number): Promise<void> {
    const entry = await this.repo.findById(entryId);
    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.TARGET_HIT,
      price,
    });
    // Close the linked trade so deployed capital is returned to cash.
    // The trigger price is forwarded so the Trade row records the actual
    // target-hit price, not the cached LTP at simulation time.
    await this.closeLinkedTrade(entry, 'target-hit', price);
    await this.repo.update(entryId, {
      status: WatchStatus.TARGET_HIT,
      closedAt: new Date(),
      closedReason: 'target-hit',
    });
    await this.unsubscribeEntry(entryId);
  }

  /**
   * Mark an un-executed entry MISSED: the alert reached its target/stop level
   * but no position was ever opened (e.g. the upside gate refused to chase a
   * price that had already run past the alert), so there is no trade to close
   * and no realised P&L. Recording MISSED rather than a phantom TARGET_HIT
   * keeps these untraded alerts out of the P&L total and makes TARGET_HIT mean
   * "a real trade that won".
   */
  async transitionMissed(entryId: string, price: number): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.NOT_TRADED,
      price,
      notes: 'reached level but no position was ever taken — MISSED',
    });
    await this.repo.update(entryId, {
      status: WatchStatus.MISSED,
      closedAt: new Date(),
      closedReason: 'missed-untraded',
    });
    await this.unsubscribeEntry(entryId);
  }

  /**
   * Journal WHY an alert was not executed (gate-rejected) as a NOT_TRADED event
   * so the reason — e.g. "already moved +2.16% from alert price" — is visible in
   * the entry's event log when the row is clicked. Best-effort: a failed journal
   * write must never block the entry flow.
   */
  private async recordNotTraded(entryId: string, reason: string): Promise<void> {
    try {
      await this.repo.createEvent({
        watchEntryId: entryId,
        eventType: WatchEventType.NOT_TRADED,
        notes: reason,
      });
    } catch {
      /* best-effort journal — never block the entry flow on a logging failure */
    }
  }

  async transitionStopped(
    entryId: string,
    score: number,
    cause: 'score-decay' | 'manual' | 'eod',
  ): Promise<void> {
    const entry = await this.repo.findById(entryId);
    // An un-executed entry was never a position, so a score-decay/EOD stop is
    // not a real STOPPED loss — record it as MISSED instead, the same as an
    // untraded alert that drifts to its target. Keeps untraded alerts out of
    // P&L and makes STOPPED mean "a real trade that was stopped out".
    if (entry && entry.status !== WatchStatus.TRADED) {
      await this.transitionMissed(
        entryId,
        (entry as any).currentPrice ?? entry.initialPrice ?? 0,
      );
      return;
    }
    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.SL_HIT_SCORE,
      score,
      notes: `cause:${cause}`,
    });
    // Close the linked trade so deployed capital is returned to cash. Forward
    // the last mark so a feed-blind close is priced, not booked at ₹0.
    await this.closeLinkedTrade(entry, `sl-${cause}`, this.lastMarkPrice(entry));
    await this.repo.update(entryId, {
      status: WatchStatus.STOPPED,
      closedAt: new Date(),
      closedReason: `sl-${cause}`,
    });
    await this.unsubscribeEntry(entryId);
  }

  /**
   * Hard loss-cut exit: a TRADED entry's open loss reached ₹1,000 on a tick.
   * Mirrors transitionStopped but is price-driven, not score-driven — it
   * writes an SL_HIT_PRICE event (the existing WatchEventType for a
   * price-based stop), closes the linked trade so cash is returned, and
   * marks the entry STOPPED with closedReason 'loss-cut'.
   */
  async transitionLossCut(
    entryId: string,
    exitPrice: number,
    openPnl: number,
  ): Promise<void> {
    const entry = await this.repo.findById(entryId);

    // Re-confirm the loss with an independent fresh REST quote before exiting.
    // A single bad feed tick (observed: a glitch tick several rupees off the
    // real price) must not trigger a real exit. If the fresh quote shows the
    // loss is not actually past the threshold, abort. When no quote can be
    // obtained, fall through and cut — a feed-blind open position is the
    // riskier state, so we fail safe toward protecting capital.
    if (entry) {
      const confirmPrice = await this.fetchLivePrice(entry);
      if (confirmPrice != null) {
        const confirmPnl = this.computeOpenPnl(entry, confirmPrice);
        if (confirmPnl > -hardLossCutRupees(entry)) {
          this.logger.warn(
            `Loss-cut aborted for ${entry.symbol}: trigger showed a ₹${Math.abs(openPnl).toFixed(0)} loss ` +
              `but a fresh quote (₹${confirmPrice.toFixed(2)}) shows ₹${Math.abs(confirmPnl).toFixed(0)} — bad tick.`,
          );
          return;
        }
        // Cap exit at the theoretical SL price — the stock may have kept
        // falling during the REST confirmation call, but the recorded loss
        // must never exceed the -0.4% hard limit regardless.
        const ref = (entry.executedPrice ?? entry.initialPrice ?? 0) as number;
        const slPrice = entry.side === 'BUY'
          ? ref * (1 - HARD_STOP_PCT)
          : ref * (1 + HARD_STOP_PCT);
        exitPrice = entry.side === 'BUY'
          ? Math.max(confirmPrice, slPrice)
          : Math.min(confirmPrice, slPrice);
        openPnl = this.computeOpenPnl(entry, exitPrice);
      }
    }

    this.logger.warn(
      `Hard loss-cut: ${entry?.symbol ?? entryId} exited at ₹${exitPrice.toFixed(2)} ` +
        `— open loss ₹${Math.abs(openPnl).toFixed(0)} (≥ ₹${hardLossCutRupees(entry ?? {}).toFixed(0)} threshold)`,
    );
    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.SL_HIT_PRICE,
      price: exitPrice,
      notes: `cause:loss-cut loss:${Math.abs(openPnl).toFixed(0)}`,
    });
    // Close the linked trade so deployed capital is returned to cash.
    // exitPrice was just confirmed by a fresh REST quote above — forward it
    // so the Trade row records the actual trigger price, not the cached LTP
    // at simulation time (the silent under-reporting bug from 2026-05-20).
    await this.closeLinkedTrade(entry, 'sl-loss-cut', exitPrice);
    await this.repo.update(entryId, {
      status: WatchStatus.STOPPED,
      closedAt: new Date(),
      closedReason: 'loss-cut',
      currentPrice: exitPrice,
    });
    await this.unsubscribeEntry(entryId);
  }

  async dismiss(entryId: string): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.DISMISSED,
    });
    await this.repo.update(entryId, {
      status: WatchStatus.DISMISSED,
      dismissedAt: new Date(),
    });
    await this.unsubscribeEntry(entryId);
  }

  /**
   * Close the broker/paper trade linked to a watch entry so the cash
   * balance is returned and the Trade record is marked CLOSED. Tolerant:
   * a broker failure is logged, never thrown — the entry status transition
   * must still proceed so the watch lifecycle is never left half-done.
   */
  /**
   * Close the linked Trade for an exiting watch entry.
   *
   * `exitPrice` MUST be passed by callers that have a known trigger price
   * (target-hit, hard loss-cut, trailing-stop). Without it, the trade-engine
   * fallback resolves the exit price from the cached LTP at simulation time,
   * which can drift several rupees from the actual trigger and silently
   * under-/over-reports realised P&L on the Trade row.
   */
  /**
   * Best last-known mark for a NON-price-triggered close (score-decay, EOD
   * square-off, manual). Returns the entry's last WS tick (`currentPrice`) when
   * usable, else undefined. Forwarding it spares the trade-engine's final
   * entryPrice fallback — which would book a real loss as ₹0 — when the live
   * quote is unavailable at close time.
   */
  private lastMarkPrice(entry: any): number | undefined {
    const px = entry?.currentPrice;
    return typeof px === 'number' && px > 0 ? px : undefined;
  }

  private async closeLinkedTrade(
    entry: any,
    reason: string,
    exitPrice?: number,
  ): Promise<void> {
    const tradeId = entry?.paperTradeId ?? entry?.liveTradeId;
    if (!tradeId) return;
    try {
      await this.trade.closeTrade(tradeId, { reason, exitPrice });
    } catch (err) {
      this.logger.warn(
        `closeLinkedTrade: failed to close trade ${tradeId} for ${entry?.symbol}: ` +
          `${err instanceof Error ? err.message : err}. Entry status still updated.`,
      );
    }
  }

  private async unsubscribeEntry(entryId: string): Promise<void> {
    const entry = await this.repo.findById(entryId);
    if (!entry) return;
    this.feed.unsubscribeForWatch(entry.token, entryId);
    if (entry.optionsToken) {
      this.feed.unsubscribeForWatch(entry.optionsToken, entryId);
    }
  }

  // ============================================
  // Risk-guard: bulk square-off
  // ============================================

  /**
   * Close every currently active (WATCHING or TRADED) watch entry. Used by
   * RiskGuardService for EOD square-off and the daily loss circuit-breaker.
   *
   * - WATCHING entries → status=DISMISSED, write DISMISSED event
   * - TRADED entries  → close the broker position via TradeExecutionService,
   *                      mark status=EXITED, write TRADE_CLOSED event
   *
   * `reason` is recorded as closedReason on every entry so the audit log
   * shows why everything got closed at once.
   */
  async squareOffAll(reason: 'eod-square-off' | 'daily-loss-breaker' | 'manual'): Promise<{
    watchingClosed: number;
    tradedClosed: number;
    errors: number;
  }> {
    this.logger.warn(`squareOffAll called — reason=${reason}`);
    const entries = await this.repo.findAllActiveOrTraded();
    let watchingClosed = 0;
    let tradedClosed = 0;
    let errors = 0;

    for (const entry of entries) {
      try {
        if (entry.status === WatchStatus.TRADED) {
          await this.closeTraded(entry.id, reason);
          tradedClosed++;
        } else {
          // WATCHING — no broker position to close, just mark DISMISSED
          await this.repo.createEvent({
            watchEntryId: entry.id,
            eventType: WatchEventType.DISMISSED,
            notes: `cause:${reason}`,
          });
          await this.repo.update(entry.id, {
            status: WatchStatus.DISMISSED,
            dismissedAt: new Date(),
            closedReason: reason,
          });
          await this.unsubscribeEntry(entry.id);
          watchingClosed++;
        }
      } catch (err) {
        this.logger.warn(
          `squareOffAll: failed to close ${entry.symbol} (${entry.id}): ${err instanceof Error ? err.message : err}`,
        );
        errors++;
      }
    }

    this.logger.warn(
      `squareOffAll complete — watching=${watchingClosed} traded=${tradedClosed} errors=${errors}`,
    );
    return { watchingClosed, tradedClosed, errors };
  }

  /**
   * Close a single TRADED entry: call broker (paper or live) to close the
   * position, mark status=EXITED, write TRADE_CLOSED event, unsubscribe feed.
   */
  async closeTraded(
    entryId: string,
    reason: string,
  ): Promise<void> {
    const entry = await this.repo.findById(entryId);
    if (!entry) throw new Error(`Watch entry ${entryId} not found`);
    if (entry.status !== WatchStatus.TRADED) {
      throw new Error(`Cannot closeTraded on entry in status ${entry.status}`);
    }

    await this.closeLinkedTrade(entry, reason, this.lastMarkPrice(entry));

    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.TRADE_CLOSED,
      price: (entry as any).currentPrice ?? null,
      notes: `cause:${reason}`,
    });
    await this.repo.update(entryId, {
      status: WatchStatus.EXITED,
      closedAt: new Date(),
      closedReason: reason,
    });
    await this.unsubscribeEntry(entryId);
  }

  // ============================================
  // Partial-exit + trailing-stop helpers
  // ============================================

  /**
   * Open (unrealized) ₹ P&L for an entry at a given price. This is the SAME
   * computation the /watch UI shows in its P&L column (web util watchPnl.ts
   * `profitView`) and that `checkPartialExitTrigger` sizes against:
   *   ref = executedPrice ?? initialPrice
   *   qty = floor(MAX_INVESTMENT_PER_TRADE / ref)
   *   pnl = (ltp - ref) × sideMul × qty   (sideMul = +1 BUY, -1 SELL)
   * Reused here so the loss-cut threshold matches the displayed P&L exactly.
   * Public so the WatchMonitorService safety-net loop computes P&L the same
   * way the per-tick loss-cut does.
   */
  computeOpenPnl(entry: any, ltp: number): number {
    const ref = entry.executedPrice ?? entry.initialPrice;
    if (!ref || ref <= 0) return 0;
    const sideMul = entry.side === 'BUY' ? 1 : -1;
    // Real open quantity: the trailing remainder after a partial exit, else
    // the full filled quantity. The floor(MAX/price) estimate is only a
    // fallback for legacy entries persisted before `quantity` was tracked.
    const qty =
      entry.remainingQty ??
      entry.quantity ??
      Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(ref, 1)));
    return (ltp - ref) * sideMul * qty;
  }

  /**
   * Phase 1 check: TRADED entry hasn't done partial exit yet. If price has
   * moved >= +1% in our favor (BUY: ltp >= entry × 1.01; SELL: ltp <= entry × 0.99),
   * trigger the partial exit:
   *   - Close PARTIAL_EXIT_FRACTION (50%) of the remaining position via broker
   *   - Set partialExitedAt, partialExitPrice, partialQty, remainingQty
   *   - Initialize trailingHighWater = ltp, trailingStopPrice = ltp ± 0.5%
   *   - Write PARTIAL_EXIT event
   */
  private async checkPartialExitTrigger(entry: any, ltp: number): Promise<void> {
    const ref = entry.executedPrice ?? entry.initialPrice;
    if (ref <= 0) return;

    const moveFavor = entry.side === 'BUY'
      ? (ltp - ref) / ref
      : (ref - ltp) / ref;

    if (moveFavor < PARTIAL_EXIT_THRESHOLD_PCT) return;

    // Trigger! Compute the split quantities for the WatchEntry bookkeeping.
    // Prefer the REAL filled quantity persisted by executeEntry; the
    // floor(MAX/ref) reconstruction is only a fallback for legacy entries.
    const initialQty =
      entry.quantity ??
      Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(ref, 1)));
    const partialQty = Math.floor(initialQty * PARTIAL_EXIT_FRACTION);
    const remainingQty = initialQty - partialQty;

    // Partially close the linked trade: closeTrade shrinks the original
    // Trade row to PARTIALLY_FILLED and credits cash for the closed slice —
    // no orphan rows, so the trades table stays a clean source of truth.
    // ltp is the partial-exit trigger price — forward it so the partial
    // slice's recorded fill matches the actual trigger, not the cached LTP
    // at simulation time (same class of bug as commit 9fb5bcd).
    const partialTradeId = entry.paperTradeId ?? entry.liveTradeId;
    if (partialTradeId) {
      try {
        await this.trade.closeTrade(partialTradeId, {
          reason: 'partial-exit',
          quantity: partialQty,
          exitPrice: ltp,
        });
      } catch (err) {
        this.logger.warn(
          `Partial exit close failed for ${entry.symbol}: ${err instanceof Error ? err.message : err}. Marking partial exit on WatchEntry anyway.`,
        );
      }
    }

    // Initialize trailing stop on the remaining half.
    const trailingStopPrice = entry.side === 'BUY'
      ? ltp * (1 - TRAILING_STOP_PCT)
      : ltp * (1 + TRAILING_STOP_PCT);

    await this.repo.createEvent({
      watchEntryId: entry.id,
      eventType: WatchEventType.PARTIAL_EXIT,
      price: ltp,
      priceDelta: moveFavor * 100,
      notes: `partial 50% sold at +${(moveFavor * 100).toFixed(2)}%, trail @ ${trailingStopPrice.toFixed(2)}`,
    });

    await this.repo.update(entry.id, {
      partialExitedAt: new Date(),
      partialExitPrice: ltp,
      partialQty,
      remainingQty,
      trailingHighWater: ltp,
      trailingStopPrice,
    });

    this.logger.log(
      `${entry.symbol}: partial exit at ₹${ltp.toFixed(2)} (+${(moveFavor * 100).toFixed(2)}%), trail stop @ ₹${trailingStopPrice.toFixed(2)}`,
    );
  }

  /**
   * Phase 2 check: TRADED entry has already done partial exit. Track the
   * most-favorable price seen since (high-water for BUY, low-water for SELL)
   * and ratchet the trailing stop. If price crosses the trailing stop in the
   * adverse direction, close the remaining half and transition to EXITED.
   */
  private async updateTrailingStop(entry: any, ltp: number): Promise<void> {
    const isBuy = entry.side === 'BUY';
    const highWater = entry.trailingHighWater ?? ltp;
    const stop = entry.trailingStopPrice ?? ltp;

    // Update high-water if price made a new extreme in our favor.
    let newHighWater = highWater;
    let newStop = stop;
    if (isBuy && ltp > highWater) {
      newHighWater = ltp;
      newStop = ltp * (1 - TRAILING_STOP_PCT);
    } else if (!isBuy && ltp < highWater) {
      newHighWater = ltp;
      newStop = ltp * (1 + TRAILING_STOP_PCT);
    }

    if (newHighWater !== highWater) {
      await this.repo.update(entry.id, {
        trailingHighWater: newHighWater,
        trailingStopPrice: newStop,
      });
    }

    // Trailing stop hit?
    const stopHit = isBuy ? ltp <= newStop : ltp >= newStop;
    if (stopHit) {
      await this.triggerTrailingStop(entry, ltp, newStop);
    }
  }

  /**
   * Trailing stop fired: close the remaining position via broker, mark
   * status=EXITED, write TRAILING_STOP_HIT event, unsubscribe feed.
   */
  private async triggerTrailingStop(entry: any, ltp: number, stopPrice: number): Promise<void> {
    this.logger.log(
      `${entry.symbol}: trailing stop hit at ₹${ltp.toFixed(2)} (high-water=${entry.trailingHighWater}, stop=${stopPrice.toFixed(2)})`,
    );

    // Close the remaining position via the linked trade — closeTrade
    // credits cash and marks the Trade record CLOSED (whatever quantity
    // remains after the earlier partial exit). ltp is the price the
    // trailing stop actually fired at — forward it so the Trade row
    // records that price, not the cached LTP at simulation time.
    await this.closeLinkedTrade(entry, 'trailing-stop', ltp);

    await this.repo.createEvent({
      watchEntryId: entry.id,
      eventType: WatchEventType.TRAILING_STOP_HIT,
      price: ltp,
      notes: `trailing stop fired (high-water ${entry.trailingHighWater}, stop ${stopPrice.toFixed(2)})`,
    });

    await this.repo.update(entry.id, {
      status: WatchStatus.EXITED,
      closedAt: new Date(),
      closedReason: 'trailing-stop',
    });

    await this.unsubscribeEntry(entry.id);
  }
}
