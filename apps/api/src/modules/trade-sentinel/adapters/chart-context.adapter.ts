import { Injectable, Logger, Optional } from '@nestjs/common';
import { SignalGeneratorService } from '../../signal-generator/services/signal-generator.service';
import type {
  AnalyzeResult,
  LevelsSnapshot,
} from '../../signal-generator/services/signal-generator.service';
import type { CandleSource } from '../../signal-generator/services/candle-source';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
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
  'no level book could be built for this symbol — either no NSE instrument matched it, or the ' +
  'level engine had no price history to build one from — so no support or resistance was ever ' +
  'computed. This is a FAILURE TO LOOK, not a finding: do not read it as an instrument with no ' +
  'structure.';

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
  /**
   * The REAL (non-stub) context-scoring factors behind this book, keyed by
   * `FactorResult.name`, NORMALISED so that positive always means "supportive of
   * a move UP" — see {@link normaliseFactors}. Empty when the engine produced
   * none, in which case {@link factorsReason} says why.
   */
  factorValues: Record<string, number>;
  /**
   * Why {@link factorValues} is empty, or null when it is populated. The four
   * emptiness cases are not the same fact and the packet cannot tell them apart
   * on its own — see the FACTORS_* constants.
   */
  factorsReason: string | null;
}

/**
 * The stub factors, excluded BY NAME.
 *
 * `FactorResult.isStub` is the runtime truth and is what we filter on, but this
 * list is what that filter is expected to remove. If a stub is ever filled in,
 * it starts flowing here automatically — which is correct — and this comment is
 * the breadcrumb for whoever then has to revisit `REAL_FACTORS` in
 * `context-factor-flip.tripwire.ts`, which hard-codes the same three names.
 */
export const FACTORS_NO_SETUP =
  'the level engine returned no active setup for this symbol, and the context-scoring factors are ' +
  'computed only as part of a setup — so no factor was evaluated. This is a FAILURE TO LOOK, not a ' +
  'finding: do not read it as a market with no directional context.';

export const FACTORS_NOT_SCORED =
  'the level engine returned a setup but attached no context score, so no factor was evaluated. ' +
  'This is a FAILURE TO LOOK, not a finding.';

export const FACTORS_ALL_STUBBED =
  'every context factor for this symbol came back as an unimplemented stub, so none carries a real ' +
  'reading. This is a FAILURE TO LOOK, not a finding.';

export const FACTORS_NO_BOOK =
  'no level book could be built for this symbol, so the context-scoring engine never ran. This is ' +
  'a FAILURE TO LOOK, not a finding.';

/**
 * Re-express factor values in ONE fixed frame: positive means "supportive of a
 * move UP", whatever side the setup happened to take.
 *
 * THIS IS NOT COSMETIC. `FactorResult.value` is defined as +1.0 = supportive of
 * `FactorInput.side`, so the SAME market read scores +0.7 under a BUY setup and
 * −0.7 under a SELL setup. `contextFactorFlip` fires on a change of SIGN between
 * two consecutive ticks, so without this every setup-side change would invert
 * every factor at once and the sensor would report that the whole macro picture
 * flipped, when all that changed was which direction the engine was proposing.
 * That is manufactured signal — the precise failure the stub exclusion in
 * `context-factor-flip.tripwire.ts` already guards the other end of.
 *
 * Anchoring to UP rather than to the POSITION's side is deliberate too: a
 * position's side is fixed for its life, so either frame would be stable for one
 * position, but only this one is comparable across positions in the corpus.
 */
export function normaliseFactors(
  factors: ReadonlyArray<{ name: string; value: number; isStub: boolean }>,
  side: 'BUY' | 'SELL',
): Record<string, number> {
  const sign = side === 'BUY' ? 1 : -1;
  const out: Record<string, number> = {};
  for (const f of factors) {
    // A stub's neutral zero is not a reading, and a NaN defeats every sign
    // comparison downstream (`Math.sign(NaN)` is NaN, which is !== every sign),
    // so it would read as a flip that never happened.
    if (f.isStub || !Number.isFinite(f.value)) continue;
    out[f.name] = f.value * sign;
  }
  return out;
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

/**
 * Every spelling of `symbol` worth trying against the NSE instrument master, in
 * order, deduplicated.
 *
 * THE `-EQ` RUNG IS THE WHOLE REASON THIS EXISTS, and its absence made the level
 * book permanently empty for every stock option this platform has ever watched.
 *
 * The master stores NSE cash equities WITH their series suffix — `KEI-EQ`,
 * `HAL-EQ`, `BDL-EQ` — and `getInstrumentBySymbol` filters `{ symbol, exchange }`
 * exactly. But a derivative's underlying arrives here as the BASE name off the
 * contract's `name` column (`KEI`), because that is what `resolveUnderlying`
 * resolves and what the news index is keyed by. So the two lookups this used to
 * make — `symbol`, then `normaliseSymbol(symbol)` — were THE SAME STRING for
 * every such underlying, and both missed. Verified against production:
 * `KEI` → no match, `KEI-EQ` → token 13310.
 *
 * The miss was invisible because it is indistinguishable from a symbol that
 * genuinely has no levels: `bookFor` returned before ever reaching `analyze()`,
 * and the packet recorded the structure as absent every single tick for the life
 * of the position. The tick source's own `resolveUnderlying` already climbed
 * this exact ladder, which is how the SPOT resolved while the BOOK did not —
 * two paths, one rung apart, drifting silently.
 *
 * Order matters: the broker's own spelling first (a cash tracker arrives as
 * `SUZLON-EQ` and must not be re-derived), then the base, then the base with the
 * suffix restored. A derivative tradingsymbol normalises to itself and carries no
 * `-` suffix, so for those this is two lookups, not three.
 */
export function masterSymbolCandidates(symbol: string): string[] {
  const raw = String(symbol ?? '').trim().toUpperCase();
  const base = normaliseSymbol(raw);
  // A Set preserves insertion order and collapses the common case where the
  // caller already passed the exact spelling the master holds.
  return [...new Set([raw, base, `${base}-EQ`])].filter((s) => s.length > 0);
}

interface CachedBook {
  at: number;
  levels: LevelsSnapshot | null;
  volumeRatio: number | null;
  factorValues: Record<string, number>;
  factorsReason: string | null;
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
 * USER-SCOPED, and it has to be. This platform has NO shared feed account, so an
 * `analyze()` called without a `CandleSource` falls through to the shared Angel
 * session and `getSmartApi()` throws `Not authenticated` for every call — the
 * level book would be empty for every symbol, permanently, and every
 * level-comparing sensor silent with it (see `candle-source.ts`). So every read
 * here takes the owning position's `userId` and builds a source bound to THAT
 * user's own Angel session, exactly as `/chart-context` does.
 *
 * When the feed manager is unwired (tests, feed-disabled containers) or the user
 * has no session, the source is undefined and `analyze()` degrades to the
 * pre-existing shared-adapter path — which on this deployment yields nothing, and
 * is then reported as an absence WITH a reason rather than as a finding.
 *
 * THE CACHE IS DELIBERATELY NOT KEYED BY USER. A level book is derived from
 * candles, and candles are public market data: the 15m book for NIFTY is the same
 * series no matter whose session paid the broker call. Which user fetched it is
 * not a property of the answer. This is the same ruling `SrEvidenceService` makes
 * for its own cache, and it matters that the two agree — a sentinel judging
 * against a different book than the chart draws would be unexplainable.
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
    // Optional for the same reason `/chart-context` makes it optional: a
    // container without the per-user feed must still construct, and must then
    // degrade visibly rather than fail to boot. See the class note.
    @Optional() private readonly userFeed?: UserFeedManager,
  ) {
    // ONCE, AT BOOT, AT WARN. Without the feed manager every level book on this
    // deployment is empty for the life of the process, and an empty book is
    // indistinguishable from a symbol whose levels were never touched — the
    // sentinel would run all session, wake nothing, and look calm. `@Optional()`
    // is what makes an unwired container boot; this is what stops it being
    // silent about what it gave up to do so.
    if (!this.userFeed) {
      this.logger.warn(
        'no UserFeedManager is wired, so every level book will be built without a per-user ' +
          'candle source. This platform has no shared feed account, so those builds will return ' +
          'nothing and the level, volume and context-factor sensors will stay dark for every ' +
          'position. Import MarketDataModule to fix.',
      );
    }
  }

  /**
   * A candle source bound to ONE user's Angel session, or undefined when there
   * is no feed manager or no user — in which case `analyze()` keeps its
   * pre-existing shared-adapter behaviour.
   *
   * Built per call rather than injected because the binding IS the user.
   */
  private candleSourceFor(userId: string | undefined): CandleSource | undefined {
    const manager = this.userFeed;
    if (!manager || !userId) return undefined;
    return {
      getCandles: (token, exchange, interval, from, to) =>
        manager.fetchCandles(userId, token, exchange, interval, from, to),
    };
  }

  /** The level book as the packet's evidence block. Null when there is none. */
  async levelsFor(symbol: string, userId?: string): Promise<SourcedValue | null> {
    const book = await this.bookFor(symbol, userId);
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
  async structureFor(
    symbol: string,
    price: number | null,
    userId?: string,
  ): Promise<SentinelStructure> {
    const book = await this.bookFor(symbol, userId);
    const volumeRatio = book?.volumeRatio ?? null;
    // Independent of the nearest-level reads below: a book can carry factors
    // while having no level on one side, and can carry levels while the engine
    // attached no context score. Sharing one reason between them would make the
    // packet state the wrong cause for one of the two.
    const factorValues = book?.factorValues ?? {};
    const factorsReason = book ? book.factorsReason : FACTORS_NO_BOOK;
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
      factorValues,
      factorsReason,
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
      factorValues,
      factorsReason,
    };
  }

  /**
   * One `analyze()` per symbol per {@link CACHE_TTL_MS}, shared by both reads
   * above. Never throws: a level book that cannot be built is a stated absence
   * downstream, never a failed evaluation.
   */
  private async bookFor(symbol: string, userId?: string): Promise<CachedBook | null> {
    const base = normaliseSymbol(symbol);
    const hit = this.cache.get(base);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

    try {
      // See `masterSymbolCandidates` — the `-EQ` rung is what makes a
      // derivative's underlying resolvable at all. Sequential and short-circuit:
      // the first spelling that hits wins, and the common case costs one query.
      let instrument = null as Awaited<
        ReturnType<MarketDataRepository['getInstrumentBySymbol']>
      >;
      for (const candidate of masterSymbolCandidates(symbol)) {
        instrument = await this.instruments.getInstrumentBySymbol(candidate, 'NSE');
        if (instrument) break;
      }
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
          `no NSE instrument matches "${symbol}" (tried ${masterSymbolCandidates(symbol).join(', ')}) ` +
            '— its level book will be empty for as long as this symbol is watched, so the level ' +
            'and volume sensors stay silent. For a derivative, callers must pass the ' +
            "UNDERLYING's name, not the tradingsymbol.",
        );
        return this.store(base, {
          at: Date.now(),
          levels: null,
          volumeRatio: null,
          factorValues: {},
          factorsReason: FACTORS_NO_BOOK,
        });
      }

      const result = await this.signals.analyze(
        instrument.token,
        instrument.exchange,
        instrument.symbol,
        SENTINEL_LEVEL_INTERVAL,
        // The whole point of the user scoping — see the class note. Undefined
        // here is the documented degradation, not a bug.
        this.candleSourceFor(userId),
      );
      /**
       * BOTH ARMS CARRY LEVELS. This line used to read
       * `result.kind === 'setup' ? result.levels : null`, and that ternary was
       * throwing away a level book the engine had already built.
       *
       * `AnalyzeResult`'s `no-setup` arm declares `levels: LevelsSnapshot | null`
       * and populates it via `snapshotFromBook(book)` whenever a book exists; it
       * is null ONLY in the one branch that genuinely has no book ("no level book
       * available — symbol has no historical data"). So `?? null` is not a
       * loosening — it is the union's own contract, read correctly.
       *
       * The distinction is the point: PDH, PDL, ORH, ORL, VWAP and today's
       * high/low are facts about MARKET STRUCTURE. They do not depend on the
       * engine liking the trade. Gating them on a setup meant that on any symbol
       * the strategy had no opinion about — which is most symbols, most of the
       * time — the sentinel was told there was no structure at all, and
       * `levelBreak` had nothing to fire on. That is a failure to look reported
       * as a finding, on the one block the whole thesis is judged against.
       *
       * `volumeRatio` below stays setup-only, and that is correct: it is computed
       * as part of SCORING a setup, not as part of the book.
       */
      const levels = result.levels ?? null;
      const volumeRatio =
        result.kind === 'setup' && Number.isFinite(result.volumeRatio) ? result.volumeRatio : null;

      // The context-scoring factors ride along on the SAME analyze() the level
      // book comes from — they are computed as part of scoring a setup, so there
      // is no separate call to make and no `SetupContext` to rebuild. Which of
      // the three empty cases we are in is recorded, because "no setup" and "all
      // stubs" would otherwise both reach the packet as a bare `{}`.
      const { factorValues, factorsReason } = this.factorsFrom(result);

      return this.store(base, { at: Date.now(), levels, volumeRatio, factorValues, factorsReason });
    } catch (err) {
      // Logged at warn, not swallowed: a permanently failing level book makes
      // `levelBreak` silent in a way that is indistinguishable from "price
      // never touched a level".
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`level book failed for ${symbol}: ${message}`);
      return null;
    }
  }

  /**
   * The real context factors from one `analyze()`, in the UP-anchored frame,
   * plus the reason when there are none.
   *
   * Exactly one of the two is meaningful at a time: a populated map has a null
   * reason, and an empty map always names which of the three ways it got there.
   * The packet turns that reason into a stated absence, so an empty map must
   * never reach it unexplained — `contextFactorFlip` has already been dark once
   * for want of this, and a silent sensor is indistinguishable from a calm one.
   */
  private factorsFrom(result: AnalyzeResult): {
    factorValues: Record<string, number>;
    factorsReason: string | null;
  } {
    if (result.kind !== 'setup') {
      return { factorValues: {}, factorsReason: FACTORS_NO_SETUP };
    }
    const factors = result.contextFactors;
    // Optional on the type: pre-scoring code paths and persisted-only setups
    // legitimately carry no breakdown at all, which is not the same fact as a
    // breakdown that turned out to be entirely stubs.
    if (!Array.isArray(factors) || factors.length === 0) {
      return { factorValues: {}, factorsReason: FACTORS_NOT_SCORED };
    }
    const factorValues = normaliseFactors(factors, result.side);
    if (Object.keys(factorValues).length === 0) {
      return { factorValues, factorsReason: FACTORS_ALL_STUBBED };
    }
    return { factorValues, factorsReason: null };
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
