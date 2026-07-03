import { Injectable, Logger, Optional } from '@nestjs/common';
import { AnandDualTrackRepository, CreatedEntryRow } from '../repositories/anand-dual-track.repository';
import { SignalFanoutService } from '../../signal-fanout/services/signal-fanout.service';
import { toPublicSignal, Segment } from '../../signal-fanout/dto/public-signal.dto';

export interface CreateEntriesInput {
  alertId: string;
  symbol: string;
  token: string | null;
  hitPrice: number;
  scoreBreakdown: unknown;
}

@Injectable()
export class AnandDualTrackService {
  private readonly logger = new Logger(AnandDualTrackService.name);

  constructor(
    private readonly repo: AnandDualTrackRepository,
    // @Optional so existing focused-boot tests (and any consumer that predates
    // the fan-out engine) can construct this service without wiring the queue.
    @Optional() private readonly fanout?: SignalFanoutService,
  ) {}

  async createEntries(input: CreateEntriesInput): Promise<void> {
    const shared = {
      symbol: input.symbol,
      token: input.token,
      entryPrice: input.hitPrice,
      alertId: input.alertId,
      scoreBreakdown: input.scoreBreakdown,
    };

    // Feature 1: record the lead on EVERY swing fire, before any guard.
    await this.repo.bumpLeadStat('swing', input.symbol).catch((err) =>
      this.logger.warn(`[anand] bumpLeadStat failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`),
    );

    // Per-track guards: skip if an active TRADED entry exists, OR the symbol
    // already hit its target today, OR (new) it made a LOSING exit today on that
    // track — don't re-enter a symbol the same day after a loss.
    const [
      activeIntraday, activeSwing,
      intradayHitToday, swingHitToday,
      intradayLossToday, swingLossToday,
    ] = await Promise.all([
      this.repo.findActiveTradedBySymbol('intraday', input.symbol),
      this.repo.findActiveTradedBySymbol('swing', input.symbol),
      this.repo.hasTargetHitTodayBySymbol('intraday', input.symbol),
      this.repo.hasTargetHitTodayBySymbol('swing', input.symbol),
      this.repo.hasLossTodayBySymbol('intraday', input.symbol),
      this.repo.hasLossTodayBySymbol('swing', input.symbol),
    ]);

    if (activeIntraday) {
      this.logger.log(`[anand] intraday: ${input.symbol} already has active TRADED entry — skipping`);
    } else if (intradayHitToday) {
      this.logger.log(`[anand] intraday: ${input.symbol} already hit target today — SKIP_TARGET_HIT_TODAY`);
    } else if (intradayLossToday) {
      this.logger.log(`[anand] intraday: ${input.symbol} already made a loss today — SKIP_LOSS_TODAY`);
    } else {
      try {
        const row = await this.repo.createIntradayEntry(shared);
        await this.emitFanout(row, 'INTRADAY');
      } catch (err) {
        this.logger.warn(`[anand-dual-track] intraday insert failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (activeSwing) {
      this.logger.log(`[anand] swing: ${input.symbol} already has active TRADED entry — skipping`);
    } else if (swingHitToday) {
      this.logger.log(`[anand] swing: ${input.symbol} already hit target today — SKIP_TARGET_HIT_TODAY`);
    } else if (swingLossToday) {
      this.logger.log(`[anand] swing: ${input.symbol} already made a loss today — SKIP_LOSS_TODAY`);
    } else {
      try {
        const row = await this.repo.createSwingEntry(shared);
        await this.emitFanout(row, 'SWING');
      } catch (err) {
        this.logger.warn(`[anand-dual-track] swing insert failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Best-effort fan-out emission (TDA-010 §7). Builds a provenance-safe
   * PublicSignal from the freshly-inserted row (via toPublicSignal → toPublicEntry
   * allowlist) and enqueues one signal-fanout job. Swallows every error so a
   * fan-out hiccup can NEVER fail or roll back the entry insert that triggered
   * it — a dropped enqueue is a missed auto-trade for one signal, not a corrupt
   * product feed. No-ops when the fan-out engine is not wired.
   */
  private async emitFanout(row: CreatedEntryRow, segment: Segment): Promise<void> {
    if (!this.fanout) return;
    try {
      await this.fanout.enqueueFanout(toPublicSignal(row, segment));
    } catch (err) {
      this.logger.warn(`[anand-dual-track] fan-out emit failed for ${row?.symbol}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
