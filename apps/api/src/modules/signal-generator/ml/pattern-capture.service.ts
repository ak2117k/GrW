import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';
import {
  buildObservationInputs,
  CHART_DETECTION_LAG_BARS,
  type ObservationMeta,
} from './observation-assembler';
import { resolveFollowThrough } from './follow-through';
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
   * the row's DECISION bar — against the row's STORED atrAtDetection, not a fresh
   * one — and finalize any that are now WIN/LOSS/TIMEOUT. Returns the number
   * finalized. One row's failure never aborts the rest.
   *
   * Both "decision bar" and "stored ATR" exist for the same reason: every row in
   * the table must be labelled on the yardstick its own features were measured
   * with. The assembler picks that yardstick at capture; this method's only job is
   * to reproduce it, never to derive a new one.
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
          // 'bulk', not 'background': RESOLVE_LOOKBACK_DAYS spans a window that
          // differs from the live-scan norm, and the adapter's cache key ignores
          // [from,to]. A background read would be served whatever short window a
          // live scan last cached (losing the anchor bar), and a background write
          // would publish this window to live consumers under the shared key.
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

        const anchor = candles.findIndex((c) => c.time === row.barTime.getTime());
        if (anchor < 0) continue;

        // `barTime` is the ANCHOR — the row's identity — not the bar it was
        // labelled from. At capture, buildObservationInputs labelled this row from
        // its DECISION bar, so the resolver has to land on that same bar or the
        // table ends up holding two yardsticks: rows that resolved at capture
        // labelled honestly, rows that went PENDING labelled from an anchor the
        // trader could not act on. Same shift, same constant, same reason as the
        // assembler — see CHART_DETECTION_LAG_BARS.
        const lag = row.category === 'CHART' ? CHART_DETECTION_LAG_BARS : 0;
        const decisionIndex = anchor + lag;
        // Not knowable yet within this window, and no bar to price the entry from.
        // Leave it PENDING for a later run rather than indexing past the end.
        if (decisionIndex >= candles.length) continue;

        // The stored bias is the direction: the row committed to one when it was
        // captured, and the label must be recomputed against that same direction
        // for the outcome to mean anything.
        const dir: 1 | -1 = row.bias === 'BEARISH' ? -1 : 1;
        // Label against the STORED atrAtDetection, never an ATR recomputed here.
        // Wilder ATR is recursive off an SMA seed, so its value depends on where
        // the window starts — and this window (RESOLVE_LOOKBACK_DAYS) is not the
        // one the row was captured from (a live scan's, or the backfill's ~120d).
        // A recompute would therefore scale the favorable/adverse levels by some
        // Y while the row keeps feature atrAtDetection = X, silently labeling
        // rows in one training table against different yardsticks — worst where
        // the anchor sits near the window start and the seed barely has bars.
        // Reusing the stored number makes feature/label consistency structural.
        const ft = resolveFollowThrough(
          candles,
          decisionIndex,
          dir,
          row.atrAtDetection,
          DEFAULT_FT_PARAMS,
        );
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
