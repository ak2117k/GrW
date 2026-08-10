import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { resolveFollowThrough } from './follow-through';
import type { OhlcvCandle } from './pattern-observation.types';
import {
  ZoneBreakObservationRepository,
  type ZoneBreakCaptureInput,
  type ZoneBreakCohort,
} from './zone-break-observation.repository';
import { selectHitRate, SYMBOL_SCOPE_MIN_SAMPLE, type HitRate } from './zone-break-hit-rate';

/**
 * Resolution horizon in bars, per timeframe — the `n` handed to
 * {@link resolveFollowThrough}. Spec §3.4.
 *
 * Shorter as the timeframe lengthens because these are wall-clock budgets in
 * disguise: 30 one-minute bars and 10 daily bars are both "give the break a fair
 * chance and then stop waiting". A timeframe absent from this map has NO defined
 * horizon, and the resolver refuses to label its rows rather than borrow one —
 * an invented horizon silently changes what WIN means for those rows.
 */
export const ZONE_BREAK_HORIZON_BARS: Record<string, number> = {
  '1m': 30,
  '5m': 24,
  '15m': 16,
  '1h': 12,
  '1d': 10,
};

/** Per-timeframe calendar-day lookback when re-fetching bars for a pending row. */
const RESOLVE_LOOKBACK_DAYS: Record<string, number> = {
  '1m': 2,
  '5m': 5,
  '15m': 10,
  '1h': 40,
  '1d': 90,
};

/** Per-timeframe calendar-day lookback for the backfill window. */
const BACKFILL_LOOKBACK_DAYS: Record<string, number> = {
  '1m': 30,
  '5m': 60,
  '15m': 120,
  '1h': 365,
  '1d': 365,
};

export interface ZoneBreakBackfillTarget {
  token: string;
  exchange: string;
  symbol: string;
}

export interface ZoneBreakBackfillResult {
  target: string;
  timeframe: string;
  observations: number;
}

/**
 * Turns a replayed candle series into capture rows. Supplied by the caller
 * rather than imported, because the geometry that decides what counts as a break
 * (Slice A) is pure and has no business being a dependency of the persistence
 * pass — and because it lets the backfill be tested without a detector.
 */
export type ZoneBreakRowBuilder = (
  candles: OhlcvCandle[],
  target: ZoneBreakBackfillTarget,
  timeframe: string,
) => ZoneBreakCaptureInput[];

/** IST is UTC+5:30; the session runs 09:15-15:30 IST on weekdays. */
const IST_OFFSET_MIN = 5 * 60 + 30;
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;

/**
 * True outside the Indian cash session (weekend, or before 09:15 / after 15:30
 * IST). The backfill is gated on this — see {@link ZoneBreakCaptureService.runBackfill}.
 * Exported so the gate itself is testable without freezing the clock.
 */
export function isOffHoursIst(now: Date): boolean {
  const istMs = now.getTime() + IST_OFFSET_MIN * 60_000;
  const ist = new Date(istMs);
  const day = ist.getUTCDay(); // 0 = Sun, 6 = Sat, in IST terms
  if (day === 0 || day === 6) return true;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes < SESSION_OPEN_MIN || minutes > SESSION_CLOSE_MIN;
}

/**
 * Capture, resolution and hit-rate lookup for `ZoneBreakObservation`.
 *
 * The three responsibilities are deliberately separated in time:
 *  - {@link capture} runs at the LIVE EDGE and only ever writes PENDING rows.
 *  - {@link resolvePending} runs later, when the horizon has actually produced
 *    bars, and is the only thing that assigns an outcome.
 *  - {@link lookupHitRate} reads what past rows resolved to, and is the only one
 *    of the three that a request path may call.
 *
 * See docs/superpowers/specs/2026-08-10-projection-zones-design.md §3.4 / §5.
 */
@Injectable()
export class ZoneBreakCaptureService {
  private readonly logger = new Logger(ZoneBreakCaptureService.name);

  /**
   * In-flight guard for the backfill, on the SERVICE rather than any one caller,
   * so it protects every entry point (a future @Cron, an ops trigger, a direct
   * call) instead of one route. Same reason and same shape as
   * PatternBackfillService: a pass is hundreds of serialized broker calls behind
   * the historical rate gate, far longer than any heartbeat's timeout, so
   * without the flag repeated triggers stack and the historical queue grows
   * without bound.
   */
  private backfillRunning = false;

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: ZoneBreakObservationRepository,
  ) {}

  /** True while a {@link runBackfill} pass is in flight. */
  get isBackfillRunning(): boolean {
    return this.backfillRunning;
  }

  /**
   * Persist confirmed breaks observed at the live edge. Every row is written
   * PENDING; nothing here labels anything.
   *
   * Fail-open: capture sits on the /chart-context request path, so a capture
   * failure must never break the chart — all errors are swallowed and reported
   * as 0. A break we failed to record simply never becomes evidence, which is
   * the honest degradation: it lowers a future sample size, it does not corrupt
   * one.
   */
  async capture(inputs: ZoneBreakCaptureInput[]): Promise<number> {
    try {
      if (!Array.isArray(inputs) || inputs.length === 0) return 0;
      return await this.repo.saveMany(inputs);
    } catch (err) {
      this.logger.warn(`capture failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  /**
   * The measured hit-rate for a projection, or `null` meaning "no measured
   * history yet".
   *
   * Reads the symbol's own tally first and only consults the cohort when the
   * symbol is below {@link SYMBOL_SCOPE_MIN_SAMPLE} — so the common, well-
   * measured case is ONE indexed read, and the cold case is two. Both are index
   * lookups with no broker involvement, which is what lets this sit behind the
   * composite's 60s cache on the request path.
   *
   * Fail-open to `null`: if the tally cannot be read we do not know the
   * hit-rate, and "we don't know" is exactly what null means. It is never
   * substituted with a default, a prior, or a number from a different scope than
   * the one reported.
   */
  async lookupHitRate(
    token: string,
    exchange: string,
    timeframe: string,
    cohort: ZoneBreakCohort,
  ): Promise<HitRate | null> {
    try {
      const symbol = await this.repo.statsForSymbol(token, exchange, timeframe);
      if (symbol.sample >= SYMBOL_SCOPE_MIN_SAMPLE) return selectHitRate(symbol, null);
      const cohortStats = await this.repo.statsForCohort(cohort);
      return selectHitRate(symbol, cohortStats);
    } catch (err) {
      this.logger.warn(`hit-rate lookup failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * For each PENDING break, re-fetch recent candles for its (token, exchange,
   * timeframe) and label it with {@link resolveFollowThrough} using the row's
   * OWN geometry: `k = targetDistAtr`, `m = stopDistAtr`, `n` = the timeframe's
   * horizon. Returns the number finalized. One row's failure never aborts the
   * rest.
   *
   * No labelling logic lives here. The whole point of storing the distances in
   * ATR units at capture is that resolution is the existing follow-through
   * routine with per-row parameters — a second implementation would be a second
   * definition of WIN.
   *
   * Unlike a CHART pattern there is no detection lag: a break is confirmed at
   * its own bar's close, so `barTime` IS the decision bar.
   */
  async resolvePending(limit = 200): Promise<number> {
    let resolved = 0;
    let pending: Awaited<ReturnType<ZoneBreakObservationRepository['findPending']>> = [];
    try {
      pending = await this.repo.findPending(limit);
    } catch (err) {
      this.logger.warn(`findPending failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }

    for (const row of pending) {
      try {
        const horizon = ZONE_BREAK_HORIZON_BARS[row.timeframe];
        if (horizon == null) {
          // No spec'd horizon for this timeframe. Borrowing another one would
          // redefine WIN for these rows against the rest of the table, so leave
          // them PENDING and say so.
          this.logger.warn(`no horizon defined for timeframe ${row.timeframe} — row ${row.id} left PENDING`);
          continue;
        }

        const lookback = RESOLVE_LOOKBACK_DAYS[row.timeframe] ?? 10;
        const to = new Date();
        const from = new Date(row.barTime.getTime() - lookback * 24 * 60 * 60 * 1000);
        const raw = await this.adapter.getHistoricalData(
          row.token,
          row.exchange,
          row.timeframe,
          from,
          to,
          // 'bulk', not 'background': the adapter's candle cache key ignores
          // [from,to], so a background read would be served whatever short
          // window a live scan last cached (losing the break bar), and a
          // background write would publish this window to live consumers under
          // the shared key.
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

        const index = candles.findIndex((c) => c.time === row.barTime.getTime());
        if (index < 0) continue;

        const dir: 1 | -1 = row.side === 'DOWN' ? -1 : 1;
        // Per-row k/m against the row's STORED ATR. Every one of these three
        // numbers was fixed when the box was drawn; recomputing any of them here
        // would label the row against a projection that was never shown.
        const ft = resolveFollowThrough(candles, index, dir, row.atrAtDetection, {
          k: row.targetDistAtr,
          m: row.stopDistAtr,
          n: horizon,
        });
        if (ft.outcome === 'PENDING') continue;

        await this.repo.updateOutcome(row.id, ft.outcome, ft.label);
        resolved++;
      } catch (err) {
        this.logger.warn(`resolve ${row.id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return resolved;
  }

  /**
   * Cold-start pass: replay history per (target × timeframe), hand each series to
   * `build`, and persist the resulting breaks as PENDING for the resolver.
   *
   * THIS MUST NEVER RUN ON A REQUEST PATH. Two independent gates enforce that,
   * and both refuse rather than queue:
   *
   *  1. **Off-hours only.** A multi-day sub-hour broker window costs one chunked,
   *     rate-limited call PER DAY on the queue the chart shares — the regression
   *     in 49d1fc1, where a widened sub-hour window starved live chart fetches.
   *     During the cash session this method returns an empty list and logs.
   *     `opts.now` exists only so the gate is testable; there is no bypass.
   *  2. **One pass at a time.** A call made while a pass is in flight is refused
   *     outright — it does not start a second pass and it does not queue behind
   *     the first, since queueing is what let overlapping triggers stack up.
   *
   * Callers that need to distinguish "refused" from "ran and found nothing"
   * should check {@link isBackfillRunning} first; that check is race-free
   * because the flag is set synchronously before the first await.
   *
   * Uses the 'bulk' priority lane for the same cache-bypass reason as
   * {@link resolvePending}.
   */
  async runBackfill(
    targets: ZoneBreakBackfillTarget[],
    build: ZoneBreakRowBuilder,
    opts: { timeframes?: string[]; lookbackDays?: number; now?: Date } = {},
  ): Promise<ZoneBreakBackfillResult[]> {
    if (!isOffHoursIst(opts.now ?? new Date())) {
      this.logger.warn('zone-break backfill refused — the cash session is open (off-hours only)');
      return [];
    }
    if (this.backfillRunning) {
      this.logger.warn('zone-break backfill refused — a pass is already in progress');
      return [];
    }
    this.backfillRunning = true;
    try {
      return await this.backfillPass(targets, build, opts);
    } finally {
      // Always release, even if a pass throws — otherwise one unexpected error
      // wedges the flag on and every later run is refused forever.
      this.backfillRunning = false;
    }
  }

  /** The actual pass. Guarded by {@link runBackfill}; never call this directly. */
  private async backfillPass(
    targets: ZoneBreakBackfillTarget[],
    build: ZoneBreakRowBuilder,
    opts: { timeframes?: string[]; lookbackDays?: number },
  ): Promise<ZoneBreakBackfillResult[]> {
    const timeframes = opts.timeframes ?? Object.keys(ZONE_BREAK_HORIZON_BARS);
    const results: ZoneBreakBackfillResult[] = [];

    for (const target of targets) {
      for (const tf of timeframes) {
        const result: ZoneBreakBackfillResult = {
          target: target.symbol,
          timeframe: tf,
          observations: 0,
        };
        try {
          const lookback = opts.lookbackDays ?? BACKFILL_LOOKBACK_DAYS[tf] ?? 120;
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

          // ATR(14) needs >14 bars before it is non-zero, and a zone needs
          // touches to be classified — too few candles yields nothing usable.
          if (candles.length >= 25) {
            result.observations = await this.repo.saveMany(build(candles, target, tf));
          }
        } catch (err) {
          this.logger.warn(
            `zone-break backfill ${target.symbol} ${tf} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        this.logger.log(`zone-break backfill ${target.symbol} ${tf}: ${result.observations} breaks`);
        results.push(result);
      }
    }
    return results;
  }
}
