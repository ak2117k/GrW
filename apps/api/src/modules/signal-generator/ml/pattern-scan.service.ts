import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { buildPatternMarkers } from '../patterns/to-markers';
import { buildObservationInputs, CHART_DETECTION_LAG_BARS } from './observation-assembler';
import { PatternObservationRepository } from './pattern-observation.repository';
import type { OhlcvCandle } from './pattern-observation.types';
// Value import (not type-only): Nest's emitDecoratorMetadata needs the class at
// runtime to auto-inject it.
import { DetectionContextService } from './detection-context.service';

/** Default set of timeframes a scan pass sweeps. */
export const SCAN_TIMEFRAMES = ['15m'];

/**
 * Per-timeframe calendar-day lookback for the fetch window. Mirrors the backfill:
 * we want enough recent bars to detect patterns and slice their feature window,
 * but the live-edge filter is what actually decides which rows survive.
 */
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

export interface ScanTarget {
  token: string;
  exchange: string;
  symbol: string;
}

export interface ScanResult {
  target: string;
  timeframe: string;
  observations: number;
}

/**
 * The live-edge scan (design spec component 3). For each (target × timeframe) it
 * fetches recent candles, detects patterns, and keeps ONLY observations whose
 * DECISION bar is the latest completed candle — then enriches each with Bucket-A
 * external context and persists.
 *
 * Why the live-edge filter is the whole point: the context services
 * (`DetectionContextService`) compute AS OF NOW — they take no historical
 * timestamp. That is only correct when the pattern's decision bar IS the live
 * edge; for an older detection (e.g. one a chart load surfaces from hours ago),
 * "as of now" would encode price action that hadn't happened when the pattern
 * formed — textbook lookahead. So historical observations are dropped here on
 * purpose. Backfill and chart-load capture keep producing the window+label rows
 * with `detectionContext = null`; this scan is the only path that captures context.
 *
 * Fetches on the 'bulk' priority lane so it neither reads nor poisons the shared
 * candle cache (whose key ignores [from,to]) — same reasoning as the backfill.
 * Fail-open per (target × timeframe): one failure never aborts the rest.
 */
@Injectable()
export class PatternScanService {
  private readonly logger = new Logger(PatternScanService.name);

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: PatternObservationRepository,
    private readonly context: DetectionContextService,
  ) {}

  async scan(
    targets: ScanTarget[],
    opts: { timeframes?: string[]; lookbackDays?: number } = {},
  ): Promise<ScanResult[]> {
    const timeframes = opts.timeframes ?? SCAN_TIMEFRAMES;
    const results: ScanResult[] = [];

    for (const target of targets) {
      for (const tf of timeframes) {
        const result: ScanResult = { target: target.symbol, timeframe: tf, observations: 0 };
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

          // ATR(14) needs >14 bars before it returns non-zero and the assembler
          // skips zero-ATR anchors — too few candles yields nothing usable.
          if (candles.length >= 25) {
            const markers = buildPatternMarkers(candles);
            const obs = buildObservationInputs(candles, markers, {
              token: target.token,
              exchange: target.exchange,
              timeframe: tf,
            });

            const lastIndex = candles.length - 1;
            const indexByTime = new Map<number, number>();
            for (let i = 0; i < candles.length; i++) indexByTime.set(candles[i].time, i);

            // Keep only observations whose DECISION bar is the latest candle. The
            // decision bar shifts by CHART_DETECTION_LAG_BARS for CHART patterns
            // (they aren't detectable at their own anchor) and by 0 for
            // CANDLESTICK — the exact same shift the assembler labels from. An
            // observation matched to no candle (should not happen — barTime came
            // from these candles) is dropped rather than trusted.
            const kept = obs.filter((o) => {
              const anchorIndex = indexByTime.get(o.barTime.getTime());
              if (anchorIndex === undefined) return false;
              const decisionIndex =
                anchorIndex + (o.category === 'CHART' ? CHART_DETECTION_LAG_BARS : 0);
              return decisionIndex === lastIndex;
            });

            if (kept.length > 0) {
              // 'as of now' == 'as of the decision bar' precisely because these
              // rows ARE at the live edge — that is what makes the context sound.
              const spot = candles[lastIndex].close;
              for (const o of kept) {
                o.detectionContext = await this.context.compute({
                  token: target.token,
                  exchange: target.exchange,
                  symbol: target.symbol,
                  bias: o.bias,
                  spot,
                  atr: o.atrAtDetection,
                });
              }
              result.observations = await this.repo.saveMany(kept);
            }
          }
        } catch (err) {
          this.logger.warn(
            `scan ${target.symbol} ${tf} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        this.logger.log(
          `scan ${target.symbol} ${tf}: ${result.observations} live-edge observations`,
        );
        results.push(result);
      }
    }
    return results;
  }
}
