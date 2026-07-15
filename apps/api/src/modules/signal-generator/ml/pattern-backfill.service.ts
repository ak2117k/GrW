import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { buildPatternMarkers } from '../patterns/to-markers';
import { buildObservationInputs } from './observation-assembler';
import { PatternObservationRepository } from './pattern-observation.repository';
import type { OhlcvCandle } from './pattern-observation.types';

export const BACKFILL_TIMEFRAMES = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '1d'];

/** Per-timeframe calendar-day lookback for the backfill window. */
const LOOKBACK_DAYS: Record<string, number> = {
  '1m': 30,
  '3m': 45,
  '5m': 60,
  '10m': 90,
  '15m': 120,
  '30m': 180,
  '1h': 365,
  '1d': 365,
};

export interface BackfillTarget {
  token: string;
  exchange: string;
  symbol: string;
}

export interface BackfillResult {
  target: string;
  timeframe: string;
  observations: number;
}

@Injectable()
export class PatternBackfillService {
  private readonly logger = new Logger(PatternBackfillService.name);

  /**
   * In-flight guard. One pass is ~527 serialized broker calls behind a 350ms
   * gate (~5-7 min), far longer than the external heartbeat's timeout — so the
   * heartbeat fires again while the previous pass is still running. Without
   * this flag those runs stack and the historical queue grows without bound.
   *
   * The guard lives on the SERVICE, not the controller, so it protects every
   * caller (HTTP trigger, future @Cron, a direct call) rather than one route.
   */
  private running = false;

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: PatternObservationRepository,
  ) {}

  /**
   * True while a `run()` pass is in flight. Callers that need to REPORT the
   * refusal (rather than just be protected from it) check this before calling
   * `run()`. That check is race-free despite being two steps: `run()` sets the
   * flag synchronously before its first `await`, and Node runs this
   * check-then-call sequence to completion without interleaving.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Replay history for each target across all (or the given) timeframes,
   * detect patterns, assemble labeled observations, and persist. One adapter
   * call per (target × timeframe); failures for one timeframe never abort the
   * rest.
   *
   * Uses the 'bulk' priority lane, NOT 'background'. Bulk shares background's
   * queue and rate gate (so it still never contends with live chart fetches),
   * but it bypasses the adapter's candle cache in both directions. That matters
   * because the cache key is `token:exchange:timeframe` and IGNORES [from,to]:
   *   - a 'background' READ would be handed whatever short window a live scan
   *     last cached (~7 days of 15m), silently truncating this replay — and for
   *     '1d' it would fall under the >= 25 bar guard and write ZERO rows;
   *   - a 'background' WRITE would publish this deep window under the shared
   *     key, where live consumers (e.g. the intraday supertrend trailing stop)
   *     would read ~3000 bars where they expect ~150 and shift a real stop.
   *
   * Concurrency: at most ONE pass runs at a time. A call made while a pass is
   * in flight is REFUSED — it does not start a second pass, and it does not
   * queue behind the first (queueing is what made overlapping heartbeats stack
   * up in the first place). It logs a warning and returns an empty result list
   * immediately; callers that need to distinguish "refused" from "ran and found
   * nothing" should check `isRunning` first, as the HTTP trigger does.
   */
  async run(
    targets: BackfillTarget[],
    opts: { timeframes?: string[]; lookbackDays?: number } = {},
  ): Promise<BackfillResult[]> {
    if (this.running) {
      this.logger.warn(
        'backfill run refused — a pass is already in progress (overlapping trigger?)',
      );
      return [];
    }
    this.running = true;
    try {
      return await this.runPass(targets, opts);
    } finally {
      // Always release, even if a pass throws — otherwise one unexpected error
      // wedges the flag on and every later run is refused forever.
      this.running = false;
    }
  }

  /** The actual pass. Guarded by `run()`; never call this directly. */
  private async runPass(
    targets: BackfillTarget[],
    opts: { timeframes?: string[]; lookbackDays?: number },
  ): Promise<BackfillResult[]> {
    const timeframes = opts.timeframes ?? BACKFILL_TIMEFRAMES;
    const results: BackfillResult[] = [];

    for (const target of targets) {
      for (const tf of timeframes) {
        const result: BackfillResult = { target: target.symbol, timeframe: tf, observations: 0 };
        try {
          const lookback = opts.lookbackDays ?? LOOKBACK_DAYS[tf] ?? 120;
          const to = new Date();
          const from = new Date(to.getTime() - lookback * 24 * 60 * 60 * 1000);

          const raw = await this.adapter.getHistoricalData(
            target.token,
            target.exchange,
            tf,
            from,
            to,
            'bulk',
          );
          const candles: OhlcvCandle[] = (raw ?? []).map((c: any) => ({
            time: c.timestamp.getTime(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: Number(c.volume ?? 0),
          }));

          // ATR(14) needs >14 bars before it returns non-zero, and the assembler
          // skips anchors whose ATR is 0 — too few candles yields nothing usable.
          if (candles.length >= 25) {
            const markers = buildPatternMarkers(candles);
            const inputs = buildObservationInputs(candles, markers, {
              token: target.token,
              exchange: target.exchange,
              timeframe: tf,
            });
            result.observations = await this.repo.saveMany(inputs);
          }
        } catch (err) {
          this.logger.warn(
            `backfill ${target.symbol} ${tf} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        this.logger.log(`backfill ${target.symbol} ${tf}: ${result.observations} observations`);
        results.push(result);
      }
    }
    return results;
  }
}
