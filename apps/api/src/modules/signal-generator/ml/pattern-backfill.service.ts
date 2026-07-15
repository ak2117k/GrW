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

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: PatternObservationRepository,
  ) {}

  /**
   * Replay history for each target across all (or the given) timeframes,
   * detect patterns, assemble labeled observations, and persist. One adapter
   * call per (target × timeframe); failures for one timeframe never abort the
   * rest. Uses the 'background' priority lane so it never contends with live
   * chart fetches.
   */
  async run(
    targets: BackfillTarget[],
    opts: { timeframes?: string[]; lookbackDays?: number } = {},
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
            'background',
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
