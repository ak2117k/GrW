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

/**
 * Why `nearestSupport`/`nearestResistance` came back null, in the three cases
 * where the answer is NOT a fact about the market.
 *
 * These exist because the packet used to describe every null level with one
 * fixed sentence — "no support level below this price in the level book" — which
 * is a POSITIVE CLAIM ABOUT MARKET STRUCTURE. It is true in exactly one of the
 * four ways the value can be null; in the other three we never got as far as
 * looking, and an LLM told "there is no support below" reasons very differently
 * from one told "we could not see the levels". Wording mirrors
 * `unresolvedUnderlying`: the absence has to name itself as a failure to look.
 */
export const LEVEL_BOOK_UNBUILT =
  'no level book could be built for this symbol — either no NSE instrument matched it or the ' +
  'level engine returned no setup — so no support or resistance was ever computed. This is a ' +
  'FAILURE TO LOOK, not a finding: do not read it as an instrument with no structure.';

export const LEVEL_BOOK_FAILED =
  'the level-book lookup FAILED for this symbol, so no support or resistance was ever computed. ' +
  'This is a FAILURE TO LOOK, not a finding: do not read it as an instrument with no structure.';

export const LEVEL_BOOK_NO_PRICE =
  "the underlying's price was unavailable, so the level book could not be placed against it and " +
  'no nearest level was ever selected. This is a FAILURE TO LOOK, not a finding — the levels ' +
  'themselves may well exist.';

/** What the tick source reads off the level book in one call. */
export interface SentinelStructure extends NearestLevels {
  volumeRatio: number | null;
  /**
   * Why the two levels are null, or NULL when the book WAS built and compared
   * and simply had no level on that side — which is the one case where "no
   * support below this price" is a true statement about the market.
   *
   * Threaded rather than discarded: this method already knows which of the four
   * cases it is in, and the packet, which does not, was inventing the answer.
   */
  reason: string | null;
  /**
   * When the level book behind these numbers was DERIVED, as an ISO string, or
   * null when there is no book. Up to {@link CACHE_TTL_MS} before the caller
   * asked — the packet must stamp THIS, not its own build time.
   */
  at: string | null;
  /** Who produced them, interval included. See {@link SENTINEL_LEVEL_SOURCE}. */
  source: string;
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

  /** Symbols already reported as unresolvable — warn once, not once per poll. */
  private readonly warned = new Set<string>();

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
    // The DERIVE time of the book, never "now" — the same instant `levelsFor`
    // reports, so one packet cannot carry two ages for one cached object.
    const at = book ? new Date(book.at).toISOString() : null;
    const blind = (reason: string): SentinelStructure => ({
      nearestSupport: null,
      nearestResistance: null,
      volumeRatio,
      reason,
      at,
      source: SENTINEL_LEVEL_SOURCE,
    });

    // The three distinctions this method knows and used to throw away. A null/NaN
    // price cannot be compared against a level: silence, not a fabricated side —
    // `levelBreak` is required to stay quiet without one — but silence WITH ITS
    // OWN REASON, which is not the same reason as having no book at all.
    if (!book) return blind(LEVEL_BOOK_FAILED);
    if (!book.levels) return blind(LEVEL_BOOK_UNBUILT);
    if (price === null || !Number.isFinite(price)) return blind(LEVEL_BOOK_NO_PRICE);

    // Book built, price finite, comparison made: a null from here IS a fact about
    // the market, so no reason is attached and the packet's own wording stands.
    return {
      ...nearestLevels(book.levels, price),
      volumeRatio,
      reason: null,
      at,
      source: SENTINEL_LEVEL_SOURCE,
    };
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
        // WARN, not debug. An unresolvable symbol here means an EMPTY LEVEL BOOK
        // FOR THE LIFE OF THE POSITION — `levelBreak` never fires and the packet
        // records the structure as absent every single time — and at production
        // log levels a `debug` is silence. That is indistinguishable from a
        // symbol whose levels were simply never touched, which is the exact
        // failure the instrument table's cash-only contents make likely for
        // anything passed an NFO tradingsymbol. Once per symbol, not per tick.
        this.warnOnce(
          base,
          `no NSE instrument matches "${symbol}" — its level book will be empty for as long as ` +
            'this symbol is watched, so the level and volume sensors stay silent. For a ' +
            'derivative, callers must pass the UNDERLYING\'s name, not the tradingsymbol.',
        );
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

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
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
