import { Injectable, Logger } from '@nestjs/common';
import type { StrongZone } from '../types/zone.types';
import type { EvidenceLevel } from '../types/evidence-level.types';
import type { LevelsSnapshot } from './signal-generator.service';

/**
 * Per-source outcome. The whole point of this endpoint is that these three
 * are DIFFERENT things: 'empty' means the engine ran and found nothing (a
 * legitimate answer the chart can state as fact), 'failed' means we don't
 * know. Collapsing them is what made the chart claim "no levels" while it was
 * actually broken or still loading.
 */
export type SourceState = 'ok' | 'empty' | 'failed';

export interface ChartContextSources {
  levels: SourceState;
  zones: SourceState;
  evidence: SourceState;
  trend: SourceState;
}

export type ChartContextStatus = 'ready' | 'partial' | 'unavailable';

export interface ChartContextDto {
  interval: string;
  /** Anchored level book (PDH/PDL/ORH/ORL/VWAP) — as served by /analyze. */
  levels: LevelsSnapshot | null;
  zones: StrongZone[];
  evidence: EvidenceLevel[];
  /** Slice 2. Always null here; `sources.trend` is 'empty', never 'failed'. */
  trend: null;
  status: ChartContextStatus;
  sources: ChartContextSources;
}

/** Loaders for the three composed sources — supplied by the controller. */
export interface ChartContextLoaders {
  levels: () => Promise<LevelsSnapshot | null | undefined>;
  zones: () => Promise<StrongZone[] | undefined>;
  evidence: () => Promise<EvidenceLevel[] | undefined>;
}

export interface ChartContextKey {
  token: string;
  exchange: string;
  interval: string;
}

/**
 * Status from the source states. Pure and exported so the truth table is
 * unit-testable without a Nest container — it is the contract the chip renders
 * from.
 */
export function deriveChartContextStatus(
  sources: Partial<ChartContextSources>,
): ChartContextStatus {
  const states = Object.values(sources).filter((s): s is SourceState => s !== undefined);
  if (states.length === 0) return 'ready';
  const failed = states.filter((s) => s === 'failed').length;
  if (failed === 0) return 'ready';
  return failed === states.length ? 'unavailable' : 'partial';
}

/** Composite cache TTL. Short: it collapses the chart's 60s poll, nothing more. */
const CACHE_TTL_MS = 60_000;
/** Bound on distinct token:exchange:interval keys held at once. */
const CACHE_MAX_ENTRIES = 500;

/**
 * Composes /analyze's level book, /zones and /sr-evidence into ONE response
 * with ONE cache and ONE status.
 *
 * Two properties matter and both are why this exists rather than the chart
 * polling three routes:
 *  1. Each source is resolved INDEPENDENTLY — an OI-wall outage degrades the
 *     evidence set, it does not blank the chart, and it never 5xxs.
 *  2. Loading / failed / genuinely-empty stay distinguishable all the way to
 *     the chip.
 *
 * The loaders are injected by the controller rather than the services being
 * injected here, because the zone path (cache read, compute-on-miss, 15m-only
 * persistence) already lives in the controller and must not be duplicated or
 * retuned — this service owns isolation, caching and status, not scoring.
 */
@Injectable()
export class ChartContextService {
  private readonly logger = new Logger(ChartContextService.name);
  private readonly cache = new Map<string, { at: number; dto: ChartContextDto }>();

  async build(key: ChartContextKey, loaders: ChartContextLoaders): Promise<ChartContextDto> {
    const cacheKey = `${key.token}:${key.exchange}:${key.interval}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.dto;

    const [levels, zones, evidence] = await Promise.all([
      this.resolve('levels', key, loaders.levels, (v) => v == null),
      this.resolve('zones', key, loaders.zones, (v) => v.length === 0),
      this.resolve('evidence', key, loaders.evidence, (v) => v.length === 0),
    ]);

    const sources: ChartContextSources = {
      levels: levels.state,
      zones: zones.state,
      evidence: evidence.state,
      // Slice 2 hasn't shipped. 'empty' (not 'failed') so an unimplemented
      // feature can never drag the response to 'partial'.
      trend: 'empty',
    };

    const dto: ChartContextDto = {
      interval: key.interval,
      levels: levels.value ?? null,
      zones: zones.value ?? [],
      evidence: evidence.value ?? [],
      trend: null,
      // Derived over the IMPLEMENTED sources only. `trend` is Slice 2 and is
      // hard-wired to 'empty', so including it would make 'unavailable'
      // unreachable — a total outage would report 'partial' forever. When
      // trend ships it joins this object and the rule needs no change.
      status: deriveChartContextStatus({
        levels: sources.levels,
        zones: sources.zones,
        evidence: sources.evidence,
      }),
      sources,
    };

    // Don't cache a total outage: a 60s-sticky 'unavailable' would keep the
    // chart blank for a minute after the underlying source recovers.
    if (dto.status !== 'unavailable') this.store(cacheKey, dto);
    return dto;
  }

  /**
   * Run one loader, never letting it throw out. A rejection is 'failed' and is
   * logged server-side so a persistent outage shows up in logs instead of
   * silently degrading every chart.
   */
  private async resolve<T>(
    name: keyof ChartContextSources,
    key: ChartContextKey,
    load: () => Promise<T | undefined>,
    isEmpty: (value: T) => boolean,
  ): Promise<{ state: SourceState; value: T | undefined }> {
    try {
      const value = await load();
      if (value === undefined) return { state: 'empty', value: undefined };
      return { state: isEmpty(value) ? 'empty' : 'ok', value };
    } catch (err) {
      this.logger.warn(
        `chart-context: ${name} failed for ${key.token}/${key.exchange}/${key.interval}: ` +
          `${err instanceof Error ? err.message : err}`,
      );
      return { state: 'failed', value: undefined };
    }
  }

  private store(cacheKey: string, dto: ChartContextDto): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Cheap bound: drop everything already past its TTL, and if that frees
      // nothing, drop the oldest insertion. Never let a long-running process
      // accumulate a key per symbol per timeframe forever.
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (now - v.at >= CACHE_TTL_MS) this.cache.delete(k);
      }
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    this.cache.set(cacheKey, { at: Date.now(), dto });
  }
}
