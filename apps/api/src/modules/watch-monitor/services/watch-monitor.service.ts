import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEntry, WatchEventType, WatchStatus } from '@prisma/client';
import { WatchRepository } from '../repositories/watch.repository';
import { ChartinkScoringService } from '../../chartink/services/chartink-scoring.service';
import { WatchService, hardLossCutRupees } from './watch.service';
import { RiskGuardService } from './risk-guard.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';

/**
 * Score-decay stop grace window: the score-decay stop is suppressed for the
 * first 10 minutes after an entry is created. Re-scores in this window are
 * data-thin (fresh entries lack enough fresh candles for a stable score), so
 * stopping on them false-killed ~97% of entries. The score is still written
 * normally during the window — only the stop transition is held off.
 */
const SCORE_DECAY_GRACE_MS = 10 * 60_000;

@Injectable()
export class WatchMonitorService {
  private readonly logger = new Logger(WatchMonitorService.name);

  constructor(
    private readonly repo: WatchRepository,
    private readonly scoring: ChartinkScoringService,
    private readonly watch: WatchService,
    private readonly riskGuard: RiskGuardService,
    private readonly feed: MarketFeedService,
  ) {}

  async tickAll(): Promise<void> {
    if (!this.isMarketHours()) return;

    // Check the daily loss breaker BEFORE running rescore — if we've already
    // hit -₹60k there's no point computing scores; just kill everything and
    // exit early. checkAndTrip returns true if breaker tripped.
    const breakerTripped = await this.riskGuard.checkAndTrip();
    if (breakerTripped) {
      this.logger.warn('Skipping rescore tick — daily loss breaker just tripped');
      return;
    }

    const entries = await this.repo.findAllActive();
    if (entries.length === 0) return;
    this.logger.debug(`rescore tick: ${entries.length} active entries`);
    const paceMs = Math.max(0, Math.floor(60_000 / Math.max(entries.length, 1)));
    for (let i = 0; i < entries.length; i++) {
      try {
        // Heal feed subscriptions first: they are in-memory and wiped on an
        // API restart, which leaves open positions with no live price.
        this.ensureFeedSubscription(entries[i]);
        // Safety net next: a hard price loss is more urgent than a score
        // recompute. If the entry is cut, skip the now-pointless rescore.
        const cut = await this.checkOpenLoss(entries[i]);
        if (!cut) await this.rescoreOne(entries[i]);
      } catch (err) {
        this.logger.warn(
          `tickAll: processing ${entries[i].symbol} threw: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (i < entries.length - 1) await this.sleep(paceMs);
    }

    // After rescore, retry any WATCHING entries whose auto-execute failed
    // earlier (typically insufficient cash, race-condition with cap, etc.).
    // The original failure may have cleared since: other positions could
    // have closed and freed cash, or the position cap setting bumped up.
    // No user click required.
    await this.retryStuckWatchingExecutes(entries);
  }

  /**
   * Re-attempt auto-execute on any WATCHING entry that was admitted but
   * never managed to open its trade. Quiet about per-entry rejection
   * reasons — same reasons that blocked it the first time often still
   * apply (cash exhausted, dup symbol, etc.). Successes flip status to
   * TRADED via the regular executeEntry path.
   */
  private async retryStuckWatchingExecutes(
    entries: WatchEntry[],
  ): Promise<void> {
    const stuck = entries.filter(
      (e) => e.status === WatchStatus.WATCHING && !e.paperTradeId && !e.liveTradeId,
    );
    if (stuck.length === 0) return;
    let retried = 0;
    let executed = 0;
    for (const e of stuck) {
      retried++;
      try {
        await this.watch.executeEntry(e.id, { mode: 'paper' });
        executed++;
        this.logger.log(
          `retryStuckWatching: ${e.symbol} flipped WATCHING → TRADED on retry`,
        );
      } catch {
        // Same blockers as before — silently keep WATCHING for the next
        // tick. The original [trade-rejected] log line covers the first
        // failure; we don't want to spam on every retry.
      }
    }
    if (retried > 0) {
      this.logger.debug(
        `retryStuckWatching: attempted ${retried}, succeeded ${executed}`,
      );
    }
  }

  /**
   * Re-subscribe an entry's token(s) to the live feed. The feed's subscription
   * map is in-memory and lost on an API restart; subscribeForWatch is only
   * called when a NEW alert arrives, so an already-open position would never
   * get ticks again after a restart — frozen ltp, +0 unrealized P&L, and a
   * blind loss-cut. subscribeForWatch is idempotent, so re-running it every
   * tick is cheap and self-heals after a restart or WebSocket reconnect.
   */
  private ensureFeedSubscription(entry: WatchEntry): void {
    this.feed.subscribeForWatch(entry.token, entry.id);
    if (entry.optionsToken) {
      this.feed.subscribeForWatch(entry.optionsToken, entry.id);
    }
  }

  /**
   * Feed-independent safety net for the price-based loss-cut. The per-tick
   * loss-cut lives in WatchService.applyTick; if that path stalls (e.g. a
   * broker tick stream freezes for a token), a TRADED entry could bleed
   * uncapped. This 60s-loop check re-evaluates open P&L from the feed quote
   * cache — populated by the feed's own tick handler, independent of the
   * watch onTick path — and hard-cuts the entry if the loss breaches the
   * limit. Returns true when the entry was cut (caller skips the rescore).
   */
  private async checkOpenLoss(entry: WatchEntry): Promise<boolean> {
    if (entry.status !== WatchStatus.TRADED) return false;
    const price =
      this.feed.getQuote(entry.token)?.ltp ?? entry.currentPrice ?? null;
    if (price == null || price <= 0) return false;
    const openPnl = this.watch.computeOpenPnl(entry, price);
    const lossCutThreshold = hardLossCutRupees(entry);
    if (openPnl <= -lossCutThreshold) {
      this.logger.warn(
        `Safety-net loss-cut: ${entry.symbol} open loss ₹${Math.abs(openPnl).toFixed(0)} ` +
          `(≥ ₹${lossCutThreshold.toFixed(0)}) caught by the feed-independent rescore loop`,
      );
      await this.watch.transitionLossCut(entry.id, price, openPnl);
      return true;
    }
    return false;
  }

  async rescoreOne(entry: WatchEntry): Promise<void> {
    let result: Awaited<ReturnType<ChartinkScoringService['score']>>;
    try {
      result = await this.scoring.score({
        token: entry.token,
        symbol: entry.symbol,
        exchange: entry.exchange,
        side: entry.side as 'BUY' | 'SELL',
        entryPrice: entry.currentPrice ?? entry.initialPrice,
        setupContext: null,
      });
    } catch (err) {
      await this.repo.update(entry.id, {
        notes: `rescore-throttled: ${err instanceof Error ? err.message : err}`,
        lastRescoreAt: new Date(),
      });
      return;
    }

    // Task 5: skip data-starved re-scores entirely. A score computed from
    // insufficient fresh candles is garbage — do NOT update currentScore, do
    // NOT evaluate the score-decay stop. Leave the entry fully untouched for
    // the next tick. An entry must NEVER be stopped on a data-starved score.
    if (result.dataStarved) {
      this.logger.debug(
        `rescoreOne: skipping ${entry.symbol} (${entry.id}) — data-starved score, entry left untouched`,
      );
      return;
    }

    const newScore = result.score;
    const priorScore = entry.currentScore ?? entry.initialScore;
    const delta = newScore - priorScore;
    const now = new Date();

    if (delta !== 0) {
      await this.repo.createEvent({
        watchEntryId: entry.id,
        eventType: WatchEventType.SCORE_CHANGE,
        score: newScore,
        scoreDelta: delta,
        breakdown: result.checks as unknown as Prisma.InputJsonValue,
      });
    }

    await this.repo.update(entry.id, {
      currentScore: newScore,
      lastRescoreAt: now,
      // Wrap as { checks } to match initialBreakdown's shape — the watch
      // table reads breakdown.checks; a bare array renders all factors as
      // the neutral dot instead of ✓/✗.
      currentBreakdown: { checks: result.checks } as unknown as Prisma.InputJsonValue,
    });

    // Task 4: 10-minute grace period. The score-decay stop is suppressed for
    // the first 10 minutes after the entry was created. The score above is
    // still written normally — only the stop transition is held off. The
    // price-based target/stop path (WatchService.applyTick) is separate and
    // remains fully active throughout.
    const createdAt = entry.createdAt ?? entry.initialAt;
    const inGraceWindow =
      !!createdAt && now.getTime() - new Date(createdAt).getTime() < SCORE_DECAY_GRACE_MS;
    if (inGraceWindow) {
      if (newScore < entry.stopLossScore) {
        this.logger.debug(
          `rescoreOne: ${entry.symbol} (${entry.id}) score ${newScore} < ${entry.stopLossScore} ` +
            `but within 10-min grace window — score-decay stop suppressed`,
        );
      }
      return;
    }

    if (newScore < entry.stopLossScore) {
      await this.watch.transitionStopped(entry.id, newScore, 'score-decay');
    }
  }

  private isMarketHours(now: Date = new Date()): boolean {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffsetMs);
    const day = ist.getUTCDay();
    if (day === 0 || day === 6) return false;
    const h = ist.getUTCHours();
    const m = ist.getUTCMinutes();
    const totalMin = h * 60 + m;
    return totalMin >= 9 * 60 + 15 && totalMin <= 15 * 60 + 30;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
