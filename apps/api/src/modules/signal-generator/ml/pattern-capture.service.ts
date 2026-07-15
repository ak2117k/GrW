import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';
import { buildObservationInputs, type ObservationMeta } from './observation-assembler';
import { resolveFollowThrough } from './follow-through';
import { computeAtrFromCandles } from '../services/per-tf-atr';
import { PatternObservationRepository } from './pattern-observation.repository';
import { DEFAULT_FT_PARAMS, type OhlcvCandle } from './pattern-observation.types';

/** Per-timeframe calendar-day lookback when re-fetching bars for a pending row. */
const RESOLVE_LOOKBACK_DAYS: Record<string, number> = {
  '1m': 2,
  '3m': 3,
  '5m': 5,
  '10m': 7,
  '15m': 10,
  '30m': 20,
  '1h': 40,
  '1d': 90,
};

@Injectable()
export class PatternCaptureService {
  private readonly logger = new Logger(PatternCaptureService.name);

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: PatternObservationRepository,
  ) {}

  /**
   * Persist observations for a LIVE detection. Rows whose horizon isn't complete
   * are stored PENDING and finalized later by resolvePending(). Fail-open:
   * capture sits on the /patterns request path, so a capture failure must never
   * break the chart overlay — all errors are swallowed and reported as 0.
   */
  async capture(
    candles: OhlcvCandle[],
    markers: PatternMarkerDto[],
    meta: ObservationMeta,
  ): Promise<number> {
    try {
      const inputs = buildObservationInputs(candles, markers, meta);
      return await this.repo.saveMany(inputs);
    } catch (err) {
      this.logger.warn(`capture failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  /**
   * For each PENDING observation, re-fetch recent candles for its
   * (token, exchange, timeframe), recompute the ATR-follow-through outcome from
   * the anchor bar, and finalize any that are now WIN/LOSS/TIMEOUT. Returns the
   * number finalized. One row's failure never aborts the rest.
   */
  async resolvePending(limit = 200): Promise<number> {
    let resolved = 0;
    let pending: Awaited<ReturnType<PatternObservationRepository['findPending']>> = [];
    try {
      pending = await this.repo.findPending(limit);
    } catch (err) {
      this.logger.warn(`findPending failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }

    for (const row of pending) {
      try {
        const lookback = RESOLVE_LOOKBACK_DAYS[row.timeframe] ?? 10;
        const to = new Date();
        const from = new Date(row.barTime.getTime() - lookback * 24 * 60 * 60 * 1000);
        const raw = await this.adapter.getHistoricalData(
          row.token,
          row.exchange,
          row.timeframe,
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

        const anchor = candles.findIndex((c) => c.time === row.barTime.getTime());
        if (anchor < 0) continue;

        const atr = computeAtrFromCandles(candles.slice(0, anchor + 1), 14);
        if (atr <= 0) continue; // can't scale a follow-through target without ATR

        // The stored bias is the direction: the row committed to one when it was
        // captured, and the label must be recomputed against that same direction
        // for the outcome to mean anything.
        const dir: 1 | -1 = row.bias === 'BEARISH' ? -1 : 1;
        const ft = resolveFollowThrough(candles, anchor, dir, atr, DEFAULT_FT_PARAMS);
        if (ft.outcome === 'PENDING') continue;

        await this.repo.updateOutcome(row.id, ft.outcome, ft.label);
        resolved++;
      } catch (err) {
        this.logger.warn(`resolve ${row.id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return resolved;
  }
}
