import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { SrLevelObservationRepository } from '../repositories/sr-level-observation.repository';
import { classifyReaction, type ReactionCandle } from './sr-level-tracking.helpers';
import type { EvidenceLevel } from '../types/evidence-level.types';

/** How long to wait after a snapshot before its reaction can be evaluated. */
const DEFAULT_GRACE_MINUTES = 90;

export interface EvaluateOptions {
  /** Only evaluate snapshots older than this many minutes (default 90). */
  graceMinutes?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Captures evidence-weighted S/R levels and, after a grace window, classifies
 * whether price respected each one — the data-collection foundation for
 * calibrating evidence weights to real hold rates.
 *
 * `snapshot()` runs at poll time (cheap insert). `evaluate()` runs later
 * (e.g. on a cron), replays the candles that followed each pending snapshot
 * via the Angel historical adapter, and records the verdict. Classification
 * lives in the pure {@link classifyReaction} helper.
 *
 * Deps are optional so unwired/test containers construct cleanly. Without the
 * adapter, `evaluate()` is a no-op (nothing to replay).
 */
@Injectable()
export class SrLevelTrackingService {
  private readonly logger = new Logger(SrLevelTrackingService.name);

  constructor(
    private readonly repo: SrLevelObservationRepository,
    @Optional() private readonly angelOneAdapter?: AngelOneAdapterService,
  ) {}

  /** Re-entrancy guard: a long backlog pass must not stampede the next cron
   *  tick (which would double every shared rate-limited historical fetch). */
  private evaluating = false;

  /** Drive evaluate() periodically so reaction verdicts (and hold-rates) accrue.
   *  Capped per pass (repo `take`) so it can't starve the shared historical-
   *  fetch budget the trading/chart path depends on. */
  @Cron('0 */30 * * * *')
  async evaluateCron(): Promise<void> {
    if (this.evaluating) {
      this.logger.debug('evaluate cron skipped — previous pass still running');
      return;
    }
    this.evaluating = true;
    try {
      const { evaluated } = await this.evaluate();
      if (evaluated > 0) this.logger.log(`evaluated ${evaluated} S/R level reactions`);
    } catch (err) {
      this.logger.warn(`evaluate cron failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.evaluating = false;
    }
  }

  /**
   * Persist one row per NON-soft level. Soft levels (e.g. the round-number
   * grid backdrop) are advisory only and excluded from reaction tracking.
   * Returns the number of rows written.
   */
  async snapshot(
    token: string,
    exchange: string,
    interval: string,
    levels: EvidenceLevel[],
    ltp: number,
    atr14?: number | null,
  ): Promise<number> {
    const rows = (levels ?? [])
      .filter((l) => !l.soft)
      .map((l) => ({
        token,
        exchange,
        interval,
        price: l.price,
        side: l.side,
        kinds: l.kinds,
        score: Math.round(l.score),
        ltpAtSnapshot: ltp,
        atr14: atr14 ?? null,
      }));
    if (rows.length === 0) return 0;
    try {
      return await this.repo.recordMany(rows);
    } catch (err) {
      this.logger.warn(
        `snapshot(${token}/${exchange}/${interval}) failed: ${err instanceof Error ? err.message : err}`,
      );
      return 0;
    }
  }

  /**
   * Evaluate pending snapshots older than the grace window: fetch the candles
   * that followed each (snapshotAt → now, at the snapshot interval), classify
   * the reaction, and persist the verdict. Returns how many were evaluated.
   */
  async evaluate(opts: EvaluateOptions = {}): Promise<{ evaluated: number }> {
    const graceMinutes = opts.graceMinutes ?? DEFAULT_GRACE_MINUTES;
    const now = opts.now ?? new Date();
    const cutoff = new Date(now.getTime() - graceMinutes * 60 * 1000);

    if (!this.angelOneAdapter) {
      this.logger.debug('evaluate() skipped — no Angel adapter wired');
      return { evaluated: 0 };
    }

    const pending = await this.repo.findUnevaluatedBefore(cutoff);
    let evaluated = 0;

    for (const obs of pending) {
      let candles: any[] = [];
      try {
        candles = await this.angelOneAdapter.getHistoricalData(
          obs.token,
          obs.exchange,
          obs.interval,
          obs.snapshotAt,
          now,
        );
      } catch (err) {
        this.logger.debug(
          `evaluate: candle fetch failed for ${obs.id} (${obs.token}): ${err instanceof Error ? err.message : err}`,
        );
        continue; // leave unevaluated; retried next pass
      }

      // getHistoricalData SILENTLY returns [] on throttle / ~6 AM session
      // expiry (it does not throw). Do not mislabel an unreplayable level as
      // UNTOUCHED — leave it pending for the next pass.
      if (!candles || candles.length === 0) continue;

      const reactionCandles: ReactionCandle[] = (candles ?? []).map((k: any) => ({
        high: k.high,
        low: k.low,
        close: k.close,
      }));

      const level: EvidenceLevel = {
        price: obs.price,
        side: obs.side as EvidenceLevel['side'],
        score: obs.score,
        kinds: (obs.kinds ?? []) as EvidenceLevel['kinds'],
        soft: false,
        distancePct: 0,
      };

      const res = classifyReaction(level, reactionCandles, obs.atr14 ?? null);
      try {
        await this.repo.markEvaluated(obs.id, {
          touched: res.touched,
          reaction: res.reaction,
          detail: res.detail,
          evaluatedAt: now,
        });
        evaluated++;
      } catch (err) {
        this.logger.warn(
          `evaluate: markEvaluated failed for ${obs.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return { evaluated };
  }
}
