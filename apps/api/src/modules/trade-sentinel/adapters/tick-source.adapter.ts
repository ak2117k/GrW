import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { NewsAggregatorService } from '../../news/services/news-aggregator.service';
import type { Segment, Side } from '../charges';
import type { TickReading, TickSource } from '../services/sentinel-cycle.service';
import { unresolvedUnderlying } from '../services/context-packet.service';
import { SENTINEL_LEVEL_SOURCE, SentinelChartContextAdapter } from './chart-context.adapter';
import { normaliseSymbol } from '../symbols';

/**
 * The window the packet's `freshCount` block names, and therefore the window
 * this must use. `ContextPacketService` labels the field
 * "headlines in the last 30 minutes" verbatim, and `newsHit` fires on any
 * non-zero value — so a wider window here would wake the agent on an hour-old
 * headline while the packet told it the headline was minutes old.
 */
export const FRESH_NEWS_WINDOW_MS = 30 * 60 * 1000;

/**
 * How stale a level-book spot may be before it stops counting as the
 * underlying's price. `LevelBook` documents 60s as its own staleness bound.
 * Past it the reading is dropped rather than used: a frozen spot compared
 * against a live level book is exactly the "present but wrong" evidence the
 * packet design forbids, and it would make `levelBreak` fire on a number
 * nothing is trading at.
 */
export const SPOT_STALENESS_MS = 60_000;

/** Derivative tradingsymbols end in the contract type. */
const OPTION_SUFFIX = /(CE|PE)$/;
const FUTURE_SUFFIX = /FUT$/;

/**
 * Which charge schedule applies. Exported and pure — this picks the STT and
 * stamp-duty rates the green floor is solved from, so getting it wrong moves
 * the floor rather than failing loudly.
 *
 * A HOLDING is delivery by definition (it settled into the demat account). A
 * cash POSITION is treated as intraday: the tracker cannot know whether the user
 * intends to carry it, and intraday is the LOWER charge schedule, so this
 * under-states charges for a position that is later delivered. Deliberate — the
 * floor is a target the agent may exceed, and a floor that is too HIGH would
 * refuse to arm on a trade that is genuinely in profit, which is the worse error.
 */
export function segmentFor(input: { exchange: string; symbol: string; kind: string }): Segment {
  const exchange = input.exchange.toUpperCase();
  const symbol = input.symbol.toUpperCase();
  const derivativeExchange = exchange === 'NFO' || exchange === 'BFO' || exchange === 'MCX';
  if (derivativeExchange || OPTION_SUFFIX.test(symbol) || FUTURE_SUFFIX.test(symbol)) {
    // Order matters: `NIFTY28AUG2524000CE` must not be read as a future by a
    // looser test, and a future never ends in CE/PE.
    if (OPTION_SUFFIX.test(symbol)) return 'OPT';
    if (FUTURE_SUFFIX.test(symbol)) return 'FUT';
    // On a derivative exchange with an unrecognisable suffix, OPT is the
    // conservative read: it carries the highest STT and exchange-txn rates, so
    // the floor sits higher and arms later rather than sooner.
    return 'OPT';
  }
  return input.kind === 'HOLDING' ? 'EQ_DELIVERY' : 'EQ_INTRADAY';
}

/**
 * The broker reports a short position as a NEGATIVE net quantity. Reading side
 * off the sign is the only source of truth available here, and it matters twice
 * over: charges are side-aware (a short's sell leg is the ENTRY), and every
 * sensor's notion of "against me" inverts with it.
 */
export function sideFor(qty: number): Side {
  return qty < 0 ? 'SHORT' : 'LONG';
}

/** A stated failure, so the cycle's per-position catch logs a cause. */
class TickUnavailable extends Error {}

/**
 * What a derivative's underlying resolves to.
 *
 * BOTH HALVES ARE NEEDED AND THEY FAIL INDEPENDENTLY. `name` is what the level
 * book and the news feed are keyed by ('NIFTY'); `token` is what the live level
 * book's spot is keyed by ('26000'). The name comes off the derivative's own
 * instrument row, the token needs a second lookup of the CASH row — so a
 * missing cash row leaves the name usable and only the spot unavailable.
 * Collapsing them into one nullable value would take the level book and the
 * news down with the spot.
 */
interface Underlying {
  name: string | null;
  token: string | null;
}

const NO_UNDERLYING: Underlying = { name: null, token: null };

/** No spot, and therefore no capture time to report for one. */
const NO_SPOT = { ltp: null, at: null } as const;

/**
 * What the level book reports when there is no symbol to ask about — the fourth
 * way the nearest levels come back null, and the only one this file owns.
 *
 * The reason is the SAME sentence the packet already puts on `structure.levelBook`
 * for this case. Without it the packet described these two nulls as "no support
 * level below this price in the level book" — a positive claim about market
 * structure, two lines below a block correctly saying we never resolved the
 * underlying at all.
 */
const NO_STRUCTURE = {
  nearestSupport: null,
  nearestResistance: null,
  volumeRatio: null,
  reason: unresolvedUnderlying("this instrument's level book"),
  at: null,
  source: SENTINEL_LEVEL_SOURCE,
} as const;

/**
 * A Date as 'YYYY-MM-DD' IN IST — never `toISOString().slice(0, 10)`.
 *
 * The instrument master builds an expiry at LOCAL midnight (see
 * `AngelOneAdapterService`/`MarketFeedService`), so on an IST host a 28-Aug
 * contract is the instant 2025-08-27T18:30:00Z and `toISOString()` slices it to
 * `2025-08-27`. Correct on a UTC host and wrong on every host east of UTC, which
 * is every host this platform actually runs a market session on. It costs twice:
 * the agent is told the contract expired yesterday ON EXPIRY DAY, and `expiry`
 * is the OI-snapshot lineage key, so a timezone change silently orphans the
 * series and re-bases `prev`.
 *
 * Same `Asia/Kolkata` Intl formatter as `istWallClock`. 'en-CA' emits ISO order.
 */
export function istDateOnly(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * `TickSource` over `trade_trackers` plus the level book and the news feed.
 *
 * PRISMA DIRECTLY, NOT `TradeTrackerService` — the same argument as
 * `OpenPositionsRepository`: that service holds the Angel One adapter, and this
 * needs six columns.
 *
 * KNOWN GAPS, stated rather than hidden, because each one makes a sensor quiet
 * and a quiet sensor is indistinguishable from a calm market:
 *
 *  - `factorValues` is always `{}`. The context-scoring engine needs a
 *    `SetupContext` this adapter does not build, so `contextFactorFlip` cannot
 *    fire and the packet's `macro.realFactors` is a stated absence.
 *  - `underlyingLtp` for a derivative depends on the underlying's spot being in
 *    the live level book. When the underlying is not subscribed, it is null and
 *    `levelBreak` and the OI capture both correctly stay silent.
 *
 * SCALE AND IDENTITY ARE TWO SEPARATE CORRECTIONS. For a derivative, both the
 * PRICE handed to the level book and the SYMBOL it is looked up by have to be
 * the underlying's — the spot AND `NIFTY`, not the spot and
 * `NIFTY28AUG2524000CE`. Getting only the price right leaves the lookup missing
 * permanently and silently, which looks exactly like a symbol with no levels.
 * See `structureSymbol` in {@link SentinelTickSource.tickFor}.
 */
@Injectable()
export class SentinelTickSource implements TickSource {
  private readonly logger = new Logger(SentinelTickSource.name);

  /** Resolved underlying per instrument token — the master does not change intraday. */
  private readonly underlyings = new Map<string, Underlying>();

  /** Derivatives already warned about having no resolvable underlying. */
  private readonly warnedNoUnderlying = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instruments: MarketDataRepository,
    private readonly levelBooks: LevelBookService,
    private readonly news: NewsAggregatorService,
    private readonly charts: SentinelChartContextAdapter,
  ) {}

  async tickFor(trackerId: string): Promise<TickReading> {
    const row = await this.prisma.tradeTracker.findUnique({
      where: { id: trackerId },
      select: {
        symbol: true,
        exchange: true,
        token: true,
        kind: true,
        entryPrice: true,
        qty: true,
        entryTime: true,
        holdingHigh: true,
        holdingLow: true,
        lastLtp: true,
      },
    });
    if (!row) throw new TickUnavailable(`tracker ${trackerId} no longer exists`);

    // No price means no judgement. Throwing is correct and is NOT a silent
    // failure: the cycle catches per position, counts it `failed` and logs the
    // symbol. Substituting the entry price would report a flat trade as flat
    // while it was actually moving, which the agent would read as calm.
    const ltp = row.lastLtp;
    if (ltp === null || !Number.isFinite(ltp)) {
      throw new TickUnavailable(
        `no live price on tracker ${trackerId} (${row.symbol}) — the tracker poller has not ` +
          'ticked it yet, or the feed is down',
      );
    }

    const segment = segmentFor(row);
    const side = sideFor(row.qty);
    const isCash = segment === 'EQ_DELIVERY' || segment === 'EQ_INTRADAY';

    // Resolved ONCE and used three times below — for the spot, for the level
    // book and for the news. They must all be talking about the same underlying.
    const underlying = isCash ? NO_UNDERLYING : await this.resolveUnderlying(row.token, row.symbol);

    // For cash the contract IS the underlying, so this must be `ltp` and never
    // null — a null silences every level-comparing sensor on every equity
    // position, and does so in a way that looks exactly like "no level was
    // touched". The cycle repairs this defensively too; it is set here so the
    // repair never has to fire.
    //
    // The `at` is the spot's own read time for a derivative, and null for cash —
    // where the underlying IS `ltp`, which carries no timestamp of its own, so
    // the packet's build time is the honest fallback rather than a borrowed one.
    const spot = isCash ? { ltp, at: null } : this.spotFor(underlying.token);
    const underlyingLtp = spot.ltp;

    /**
     * THE SYMBOL THE LEVEL BOOK AND THE NEWS FEED ARE KEYED BY — and for a
     * derivative that is NOT the tradingsymbol.
     *
     * `underlyingLtp` above already answers "which PRICE is on the level book's
     * scale". This is the other half of the same question, and getting only the
     * price right buys nothing: `SentinelChartContextAdapter` resolves its
     * symbol through `getInstrumentBySymbol(symbol, 'NSE')`, which filters
     * `{ symbol, exchange }` exactly. `NIFTY28AUG2524000CE` is an NFO
     * tradingsymbol — and per the instrument-master refresh only CASH equities
     * are in that table at all — so it matches NOTHING, permanently, for every
     * derivative position, no matter how good the spot is. Same for the news:
     * `relatedSymbols` holds base symbols, so the tradingsymbol never matches
     * and `newsHit` is dark too.
     *
     * Null rather than a fallback to the tradingsymbol when the underlying
     * cannot be resolved. Falling back would restore exactly the silent
     * permanent miss this fixes, dressed as an attempt.
     */
    const structureSymbol = isCash ? row.symbol : underlying.name;

    const [structure, freshNewsCount] = await Promise.all([
      structureSymbol
        ? this.charts.structureFor(structureSymbol, underlyingLtp)
        : Promise.resolve(NO_STRUCTURE),
      // Null, not 0 — "no reading" and "nothing published" must stay apart.
      structureSymbol ? this.freshNewsCount(structureSymbol) : Promise.resolve(null),
    ]);

    return {
      segment,
      side,
      entryPrice: row.entryPrice,
      // ABSOLUTE. `sideFor` has already taken the sign, and the charge model
      // and P&L arithmetic both multiply by qty — leaving it negative for a
      // short would invert the P&L a second time and report a winning short as
      // a loser.
      qty: Math.abs(row.qty),
      ltp,
      underlyingLtp,
      underlyingLtpAt: spot.at,
      // Carried so the packet builder and the thesis inference look their
      // evidence up by the SAME symbol these sensors did. Resolved once, here;
      // a second resolution downstream is how the two paths came to disagree.
      structureSymbol,
      nearestSupport: structure.nearestSupport,
      nearestResistance: structure.nearestResistance,
      // Provenance for the three level-book-derived numbers above and below.
      // `structureReason` is null when the book WAS built and compared — only
      // then may the packet say "no level on that side", which is a claim about
      // the market rather than about us.
      structureReason: structure.reason,
      structureAt: structure.at,
      structureSource: structure.source,
      holdingHigh: row.holdingHigh,
      holdingLow: row.holdingLow,
      entryTime: row.entryTime,
      expiry: await this.expiryFor(row.token, segment),
      volumeRatio: structure.volumeRatio,
      freshNewsCount,
      // See the class note: the context-scoring engine is not wired here, so
      // this is empty and the packet records `macro.realFactors` as absent with
      // a reason rather than as an empty reading.
      factorValues: {},
    };
  }

  /**
   * The UNDERLYING's spot for a derivative, or null.
   *
   * Null is a first-class answer: `levelBreak` and the OI capture are both
   * required to stay silent without a spot, because a level or a strike is on
   * the underlying's scale while the contract's `ltp` is a premium — comparing
   * 120 against a 24000 strike reads as a permanent breach.
   */
  private spotFor(underlyingToken: string | null): { ltp: number | null; at: string | null } {
    if (!underlyingToken) return NO_SPOT;

    const book = this.levelBooks.getLevels(underlyingToken);
    if (!book || !Number.isFinite(book.spot) || book.spot <= 0) return NO_SPOT;
    // See SPOT_STALENESS_MS — a frozen spot is worse than no spot.
    if (Date.now() - book.lastTickAt.getTime() > SPOT_STALENESS_MS) return NO_SPOT;
    // The TICK time, not now: this reading is allowed to be up to
    // SPOT_STALENESS_MS old, and the packet stamps `at` from it. Reporting the
    // build time would tell the agent a minute-old spot was read this instant.
    return { ltp: book.spot, at: book.lastTickAt.toISOString() };
  }

  /**
   * The underlying behind a derivative, memoised.
   *
   * A resolved answer is cached — the instrument master does not change
   * intraday — and so is a resolved-to-nothing answer, which is a FACT about
   * this contract. A THROW is not cached: caching it would let one bad lookup
   * silence the level sensors for the rest of the process's life.
   */
  private async resolveUnderlying(token: string, symbol: string): Promise<Underlying> {
    const cached = this.underlyings.get(token);
    if (cached) return cached;

    let resolved: Underlying = NO_UNDERLYING;
    try {
      const contract = await this.instruments.getInstrumentByToken(token);
      // The instrument master stores the UNDERLYING under `name` for a
      // derivative row ('NIFTY' for NIFTY28AUG2524000CE).
      const name = contract?.name ? normaliseSymbol(contract.name) : null;
      if (name) {
        const cash =
          (await this.instruments.getInstrumentBySymbol(name, 'NSE')) ??
          // Cash equities carry the series suffix in the master.
          (await this.instruments.getInstrumentBySymbol(`${name}-EQ`, 'NSE'));
        // The name survives a missing cash row: only the SPOT needs the token,
        // while the level book and the news only ever needed the name.
        resolved = { name, token: cash?.token ?? null };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`could not resolve the underlying for ${symbol}: ${message}`);
      return NO_UNDERLYING;
    }

    if (resolved.name === null) {
      this.warnOnce(
        token,
        `no underlying name on the instrument master for ${symbol} — its level book, its news ` +
          'and its OI walls are all unavailable, so the level, volume and news sensors will ' +
          'stay silent on this position for as long as it is held',
      );
    } else if (resolved.token === null) {
      this.warnOnce(
        token,
        `resolved ${symbol} to underlying ${resolved.name}, but no NSE cash/index instrument ` +
          'for it — the level book and news still work, the underlying SPOT does not, so the ' +
          'level and OI sensors stay silent',
      );
    }
    this.underlyings.set(token, resolved);
    return resolved;
  }

  /** One line per contract, not one per tick — this is polled every 30 seconds. */
  private warnOnce(token: string, message: string): void {
    if (this.warnedNoUnderlying.has(token)) return;
    this.warnedNoUnderlying.add(token);
    this.logger.warn(message);
  }

  /** The nearest expiry as 'YYYY-MM-DD', or null for cash (the OI capture key). */
  private async expiryFor(token: string, segment: Segment): Promise<string | null> {
    if (segment !== 'OPT' && segment !== 'FUT') return null;
    try {
      const contract = await this.instruments.getInstrumentByToken(token);
      const expiry = contract?.expiry;
      if (!expiry) return null;
      return istDateOnly(expiry);
    } catch {
      // A missing expiry means no OI capture for this position — which the
      // snapshot service already treats as a stated absence.
      return null;
    }
  }

  /**
   * Headlines in the last {@link FRESH_NEWS_WINDOW_MS}, or null.
   *
   * NULL, NOT ZERO, on failure. `newsHit` treats a finite count below 1 as "no
   * news" and null as "no reading", and those must stay distinguishable: a
   * failing aggregator reported as 0 tells the agent, with provenance, that
   * nothing has been published.
   */
  private async freshNewsCount(symbol: string): Promise<number | null> {
    try {
      const articles = await this.news.getNewsForSymbol(normaliseSymbol(symbol));
      const cutoff = Date.now() - FRESH_NEWS_WINDOW_MS;
      return articles.filter((a) => a.publishedAt.getTime() >= cutoff).length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`fresh-news count failed for ${symbol}: ${message}`);
      return null;
    }
  }
}
