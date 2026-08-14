import { Injectable, Logger } from '@nestjs/common';
import { SignalGeneratorService } from '../../signal-generator/services/signal-generator.service';
import type { LevelsSnapshot } from '../../signal-generator/services/signal-generator.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import type { ChartContextShim, SourcedValue } from '../services/context-packet.service';
import { normaliseSymbol } from '../symbols';

/**
 * The timeframe the sentinel's level book is built from.
 *
 * THIS IS A TRADING DECISION, not a default, and it is stated here because the
 * level book is the thing `levelBreak` fires on and the thing the thesis is
 * inferred against. A 5-minute book breaks and re-forms all session and would
 * wake the agent on noise; a daily book barely moves and would let a position
 * lose its whole structure between looks.
 *
 * 15m for three reasons: it is what every other chart read in this repo
 * defaults to (`/chart-context`, `/analyze`, `/zones`), so the sentinel judges a
 * position against the same levels the user is looking at on screen; it is the
 * only interval whose zones are persisted, so the engine is best calibrated
 * there; and it is roughly the horizon of the positions this stage watches.
 *
 * It is folded into the block's `source` string below. Without that, two stored
 * packets could both read `chart-context.service` while carrying a 5-minute and
 * a daily level book, and Task 13's replay would have no way to tell them apart
 * — a provenance string that does not identify the data is not provenance.
 */
export const SENTINEL_LEVEL_INTERVAL = '15m';

/** Provenance, stated once so `levelsFor` and `structureFor` cannot disagree. */
export const SENTINEL_LEVEL_SOURCE = `signal-generator.analyze (${SENTINEL_LEVEL_INTERVAL} level book)`;

/**
 * How long one symbol's level book is reused. Matched to
 * `ChartContextService`'s own composite TTL: the level book is rebuilt from
 * 15-minute bars, so re-deriving it on a 30-second poll is pure cost.
 */
const CACHE_TTL_MS = 60_000;

/** Bound on cached symbols, so a long-lived process cannot accumulate forever. */
const CACHE_MAX_ENTRIES = 200;

/** The nearest level below and above a price, from the anchored level book. */
export interface NearestLevels {
  nearestSupport: number | null;
  nearestResistance: number | null;
}

/** What the tick source reads off the level book in one call. */
export interface SentinelStructure extends NearestLevels {
  volumeRatio: number | null;
}

/**
 * Every anchored line the level book carries, as bare numbers.
 *
 * Exported and pure so the "which level is nearest" rule is testable without a
 * broker. Non-finite entries are dropped rather than compared: a NaN VWAP that
 * survived into a comparison would read as "no level" on one tick and as a
 * breach on the next, and `levelBreak` would fire on an artefact.
 */
export function levelCandidates(levels: LevelsSnapshot): number[] {
  const raw = [
    levels.pdh,
    levels.pdl,
    levels.orh,
    levels.orl,
    levels.prevOrh,
    levels.prevOrl,
    levels.vwap,
    levels.todayHigh,
    levels.todayLow,
  ];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/**
 * The nearest level strictly below `price` (support) and strictly above it
 * (resistance).
 *
 * STRICTLY, on both sides. A level exactly equal to the price is neither: it has
 * not been lost and it has not been reclaimed, and admitting it as support would
 * make `levelBreak` fire the instant price ticked one paisa through a line it is
 * merely sitting on.
 */
export function nearestLevels(levels: LevelsSnapshot, price: number): NearestLevels {
  if (!Number.isFinite(price)) return { nearestSupport: null, nearestResistance: null };
  const candidates = levelCandidates(levels);
  const below = candidates.filter((v) => v < price);
  const above = candidates.filter((v) => v > price);
  return {
    nearestSupport: below.length > 0 ? Math.max(...below) : null,
    nearestResistance: above.length > 0 ? Math.min(...above) : null,
  };
}

interface CachedBook {
  at: number;
  levels: LevelsSnapshot | null;
  volumeRatio: number | null;
}

/**
 * The sentinel's level book: `ChartContextShim` for the packet, plus the
 * nearest-level read the tick source needs.
 *
 * WHY IT DOES NOT CALL `ChartContextService`, despite that being the composite
 * this repo built for exactly this data. That service caches by
 * `token:exchange:interval` and is SHARED with the charts page. The sentinel
 * only wants the level book, so it would have to pass no-op loaders for zones,
 * evidence, trend, trade plan and projections — and `resolve()` records an
 * absent loader as `'empty'`, meaning "ran and found nothing". A sentinel poll
 * landing first would therefore park a DTO in the shared cache that tells the
 * charts page, for up to a minute and in the page's own words, that there are
 * no zones and no trend. Reporting a source as empty when it never ran is the
 * one thing that whole service exists to prevent, so the sentinel takes the
 * level book straight from `analyze()` and keeps its own small cache instead.
 *
 * NOT USER-SCOPED, and this is a known limitation rather than an oversight.
 * `ChartContextShim.levelsFor(symbol)` carries no user, so `analyze()` is called
 * without a `CandleSource` and falls through to the SHARED Angel session — which
 * this platform has no feed account for (see `candle-source.ts`). Where that
 * path yields nothing, this returns null and the packet records an absent block
 * WITH a reason, which is the honest degradation. Fixing it properly means
 * threading `userId` through `ChartContextShim`, which changes an interface
 * Tasks 9 and 10 built against — reported, not smuggled in here.
 */
@Injectable()
export class SentinelChartContextAdapter implements ChartContextShim {
  private readonly logger = new Logger(SentinelChartContextAdapter.name);
  private readonly cache = new Map<string, CachedBook>();

  constructor(
    private readonly signals: SignalGeneratorService,
    private readonly instruments: MarketDataRepository,
  ) {}

  /** The level book as the packet's evidence block. Null when there is none. */
  async levelsFor(symbol: string): Promise<SourcedValue | null> {
    const book = await this.bookFor(symbol);
    if (!book?.levels) return null;
    return {
      value: { ...book.levels, interval: SENTINEL_LEVEL_INTERVAL },
      source: SENTINEL_LEVEL_SOURCE,
      // When the book was DERIVED, not when the packet asked for it — this
      // value can be up to CACHE_TTL_MS old.
      at: new Date(book.at).toISOString(),
    };
  }

  /**
   * The nearest support/resistance around `price`, on the UNDERLYING's scale.
   *
   * The tick source feeds these to `levelBreak`, which compares them against
   * `underlyingLtp`. Passing an option's premium as `price` here would return
   * levels around 120 for a 24000-strike book — so callers must pass the
   * underlying's price, never the contract's.
   */
  async structureFor(symbol: string, price: number | null): Promise<SentinelStructure> {
    const book = await this.bookFor(symbol);
    const volumeRatio = book?.volumeRatio ?? null;
    // A null/NaN price cannot be compared against a level. Silence, not a
    // fabricated side — `levelBreak` is required to stay quiet without one.
    if (price === null || !Number.isFinite(price) || !book?.levels) {
      return { nearestSupport: null, nearestResistance: null, volumeRatio };
    }
    return { ...nearestLevels(book.levels, price), volumeRatio };
  }

  /**
   * One `analyze()` per symbol per {@link CACHE_TTL_MS}, shared by both reads
   * above. Never throws: a level book that cannot be built is a stated absence
   * downstream, never a failed evaluation.
   */
  private async bookFor(symbol: string): Promise<CachedBook | null> {
    const base = normaliseSymbol(symbol);
    const hit = this.cache.get(base);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

    try {
      // The broker's tradingsymbol first (the NSE instrument master stores
      // `SUZLON-EQ` under `symbol`), then the base — a derivative tradingsymbol
      // normalises to itself, so this is one lookup for those.
      const instrument =
        (await this.instruments.getInstrumentBySymbol(symbol, 'NSE')) ??
        (await this.instruments.getInstrumentBySymbol(base, 'NSE'));
      if (!instrument) {
        this.logger.debug(`no NSE instrument for ${symbol} — no level book`);
        return this.store(base, { at: Date.now(), levels: null, volumeRatio: null });
      }

      const result = await this.signals.analyze(
        instrument.token,
        instrument.exchange,
        instrument.symbol,
        SENTINEL_LEVEL_INTERVAL,
      );
      // `analyze` returns a discriminated union; only the 'setup' arm carries a
      // level book and a volume ratio. Anything else is a genuine "no book".
      const levels = result.kind === 'setup' ? result.levels : null;
      const volumeRatio =
        result.kind === 'setup' && Number.isFinite(result.volumeRatio) ? result.volumeRatio : null;
      return this.store(base, { at: Date.now(), levels, volumeRatio });
    } catch (err) {
      // Logged at warn, not swallowed: a permanently failing level book makes
      // `levelBreak` silent in a way that is indistinguishable from "price
      // never touched a level".
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`level book failed for ${symbol}: ${message}`);
      return null;
    }
  }

  private store(key: string, entry: CachedBook): CachedBook {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (now - v.at >= CACHE_TTL_MS) this.cache.delete(k);
      }
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    this.cache.set(key, entry);
    return entry;
  }
}
