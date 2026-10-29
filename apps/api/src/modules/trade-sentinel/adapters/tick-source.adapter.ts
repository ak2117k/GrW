import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lookupHubPrices, type HubPriceSource, type HubPrices } from '../../market-hub/hub-prices';
import { isHubExchange, type InstrumentRef } from '../../market-hub/hub.types';
import { INDEX_UNDERLYINGS, resolveUnderlying as resolveUnderlyingRef } from '../../market-hub/underlying';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { NewsAggregatorService } from '../../news/services/news-aggregator.service';
import { startOfLocalDay } from '../../market-data/services/master-contract';
import { segmentFor } from '../charges';
import type { Segment, Side } from '../charges';
import type { TickOptions, TickReading, TickRow, TickSource } from '../services/sentinel-cycle.service';
import {
  SPOT_SOURCE_CASH,
  SPOT_SOURCE_HUB,
  SPOT_SOURCE_LIVE,
  SPOT_SOURCE_QUOTE,
  unresolvedUnderlying,
} from '../services/context-packet.service';
import { SENTINEL_LEVEL_SOURCE, SentinelChartContextAdapter } from './chart-context.adapter';
import { normaliseSymbol } from '../symbols';
import { newsKeyFor } from '../../news/services/underlying-news-aliases';
import { EXIT_DISCIPLINE_CONFIG, type ExitDisciplineConfig } from '../../exit-discipline/config';
import { noiseFromBars, scaledUnderlyingNoise } from '../../exit-discipline/noise';
import type { NoiseReading } from '../../exit-discipline/types';
import { sessionFor } from '../market-sessions';
import type { EquityLeg, EquityTickInputs } from '../services/equity-blocks';
import { MinuteBarsReader } from './minute-bars.reader';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../../news-events/config';
import { newsPositionOf } from '../../news-events/keys';
import type { FreshItem } from '../../news-events/types';
import { NEWS_INDEX, type NewsIndexReader } from '../ports/news-index.port';
import { HighImpactNewsBook, mergeImpactNews } from '../services/high-impact-news-book';

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

/**
 * How old the CONTRACT's own price may be before this refuses to judge at all.
 *
 * THE GAP THIS CLOSES. `spotFor` has bounded the underlying's staleness since
 * day one, while `ltp` — the more important number by far — had only a null
 * check. That asymmetry was not a decision: the spot arrives from a cache whose
 * `lastTickAt` sits right there in the same object, so its age was impossible to
 * ignore; `ltp` arrives from a database column that looks authoritative and
 * carries its freshness in a NEIGHBOURING column nobody read.
 *
 * It was found live. `KEI29SEP265800CE` sat at `lastLtp` 269.95 with an
 * `updatedAt` of 14:10 the previous day — twenty-one hours cold, while the cash
 * trackers beside it updated that morning — because the feed's primary slots
 * (30) are exhausted by the default universe before the tracker poller gets to
 * subscribe any open position. Nothing was broken loudly: the price was present,
 * finite and positive, so gross P&L, the charges, the green floor, every
 * excursion and every tripwire would have been computed from it and reported
 * with full provenance as the state of the market NOW.
 *
 * Refusing is the right failure. `ltp` is not a `Block` and cannot be a stated
 * absence — the money arithmetic is unconditional and there is no honest way to
 * price a position without a price. So a stale tick throws, the cycle counts the
 * position `failed` and logs the symbol and the age, and the agent is not asked
 * a question it would answer confidently from yesterday.
 *
 * Five minutes: the quote sweep runs every 4s and `applyTick` debounces, so a
 * healthy in-session tracker is seconds old and anything past a few minutes
 * means the token is not being fed. Out of session everything is legitimately
 * stale, which costs nothing — `SentinelRunnerService` only ticks inside
 * 09:15–15:30 IST, so this bound only ever bites when a price SHOULD be moving.
 */
export const LTP_STALENESS_MS = 5 * 60_000;

/**
 * SP1 M3: the hub's price is used for a judgement only if it is at most this old
 * (spec §5.3, "trading decisions 10 s"). Older, and the existing tiers decide.
 */
export const HUB_DECISION_MAX_AGE_MS = 10_000;

/**
 * Re-exported from `charges.ts`, where it now lives beside the `Segment` it
 * returns and the rate tables it selects. Moved so the ROSTER can classify a
 * trade without importing this file, which reaches `UserFeedManager` and
 * through it the broker — that import would break the Stage-0 isolation
 * property the cycle spec walks the import graph to assert.
 */
export { segmentFor };

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
 * book's spot is keyed by ('99926000'). The name comes off the derivative's own
 * instrument row; the token comes from the index map for an index, a second
 * lookup of the NSE CASH row for a stock, or the nearest-expiry FUTURE of the
 * same name for an MCX contract — so a missing row leaves the name usable and
 * only the spot unavailable.
 * Collapsing them into one nullable value would take the level book and the
 * news down with the spot.
 */
interface Underlying {
  name: string | null;
  token: string | null;
  /** The exchange `token` belongs to (NSE for NIFTY and stocks, BSE for SENSEX). */
  exchange: string | null;
  /**
   * The contract's tradingsymbol behind `token` — set only for an MCX future,
   * where it is handed to the level book as the instrument to chart. Null for
   * NSE/BSE underlyings, which the level book resolves by name as before.
   */
  contract: string | null;
}

const NO_UNDERLYING: Underlying = { name: null, token: null, exchange: null, contract: null };

/**
 * How long a broker quote for one underlying is reused.
 *
 * Under the sentinel's 30-second tick (`SENTINEL_TICK_CRON`) this is deliberately
 * BELOW the tick, so each tick fetches its own quote and no packet is ever
 * stamped with a price from the previous cycle. What it does collapse is the
 * within-tick case: several contracts on one underlying — two strikes, a
 * straddle, a hedge — resolve to one broker call instead of one per position.
 */
export const SPOT_QUOTE_TTL_MS = 20_000;

/**
 * How long a MISSED "NIFTY at entry" read is remembered before it is tried again. A found close
 * never changes (it is a past bar); a miss may fill in when the hub flushes late, so it is retried,
 * but not on every 30 s look — one indexed DB read per position per five minutes at most.
 */
export const ANCHOR_MISS_RETRY_MS = 5 * 60_000;

/** 'HH:MM' of an instant in IST (UTC+5:30, no DST). */
function istWallHhmm(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(11, 16);
}

/** A resolved underlying price, or a stated absence naming what was tried. */
interface SpotReading {
  ltp: number | null;
  at: string | null;
  source: string;
  /** Null when `ltp` is present. Otherwise names the tiers that were attempted. */
  reason: string | null;
}

/** No spot, and therefore no capture time to report for one. */
const NO_SPOT: SpotReading = {
  ltp: null,
  at: null,
  source: SPOT_SOURCE_LIVE,
  reason:
    'no underlying could be resolved for this contract, so no spot was ever requested — ' +
    'neither the live feed nor a broker quote was asked. This is a FAILURE TO LOOK, not a ' +
    'finding: the underlying is trading, we simply could not name it.',
};

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
  // Same cause, its own sentence. The context factors are computed by the level
  // engine, so an unresolved underlying means they were never evaluated either —
  // and saying so is not the same as saying the macro picture is neutral.
  factorValues: {},
  factorsReason: unresolvedUnderlying('the context-scoring factors'),
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

/** The hub's ref for an instrument, or null for an exchange the hub does not speak. */
function toHubRef(exchange: string | null | undefined, token: string, symbol: string): InstrumentRef | null {
  const ex = String(exchange ?? '').toUpperCase();
  return isHubExchange(ex) && token ? { exchange: ex, token, symbol } : null;
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
 *  - `factorValues` carries only the factors the level engine attaches to an
 *    ACTIVE SETUP on the underlying. With no setup there is nothing to score, so
 *    the map is empty and `contextFactorFlip` stays quiet — correctly, but it
 *    means the sensor is live only while the engine has a setup on that symbol.
 *    The packet states which of the four emptiness causes applies.
 *  - `underlyingLtp` for a derivative comes from the hub (when HUB_PRICES_POSITIONS
 *    serves this user), else the live level book, else a broker quote on the
 *    underlying's own exchange. When all three are empty it is null, and
 *    levelBreak and the OI capture both correctly stay silent.
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

  /** Recent broker quotes per underlying token — see {@link SPOT_QUOTE_TTL_MS}. */
  private readonly quotes = new Map<string, { at: number; ltp: number; capturedAt: string }>();

  private hubSourceRef: HubPriceSource | null = null;

  /** NIFTY at each position's entry (equity block F5): a found close is kept for the position's life, a miss retried after {@link ANCHOR_MISS_RETRY_MS}. */
  private readonly niftyAnchors = new Map<string, { close: number | null; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instruments: MarketDataRepository,
    private readonly levelBooks: LevelBookService,
    private readonly news: NewsAggregatorService,
    private readonly charts: SentinelChartContextAdapter,
    // Optional for the same reason `SentinelChartContextAdapter` makes it
    // optional: a container without the per-user feed must still construct and
    // must degrade visibly rather than fail to boot. Without it the spot has
    // only its live-feed tier, which is the state that made every derivative
    // position blind — so its absence is warned about at boot, below.
    @Optional() private readonly userFeed?: UserFeedManager,
    // SP1 M3: HUB_PRICE_SOURCE, resolved lazily (MarketHubModule is not imported here). Absent ⇒ no hub tier.
    @Optional() private readonly moduleRef?: ModuleRef,
    // Exit discipline §3: the 1-minute noise unit, read from candles_1m (a DB
    // read — never a broker call). Absent either ⇒ `tick.noise` is null.
    @Optional() private readonly minuteBars?: MinuteBarsReader,
    @Optional() @Inject(EXIT_DISCIPLINE_CONFIG) private readonly discipline?: ExitDisciplineConfig,
    // News & events v2: with NEWS_EVENTS_V2_ENABLED=true the fresh count (and ids)
    // come from the in-memory index. Absent / observe / false ⇒ the legacy read.
    @Optional() @Inject(NEWS_EVENTS_CONFIG) private readonly newsCfg?: NewsEventsConfig,
    @Optional() @Inject(NEWS_INDEX) private readonly newsIndex?: NewsIndexReader,
    // News impact: a HIGH impact on this underlying, as one more fresh headline (once per cluster).
    @Optional() private readonly impactBook?: HighImpactNewsBook,
  ) {
    if (!this.userFeed) {
      this.logger.warn(
        'no UserFeedManager is wired, so the underlying spot has only its live-feed tier. The ' +
          'live feed seeds a fixed universe (indices, five major stocks, five commodities), so ' +
          'for any position outside it the spot will be permanently unavailable — and with it ' +
          'the nearest levels, the levelBreak sensor and the OI walls. Import MarketDataModule ' +
          'to restore the broker-quote tier.',
      );
    }
  }

  async tickFor(trackerId: string, opts: TickOptions = {}): Promise<TickReading> {
    const row = await this.prisma.tradeTracker.findUnique({
      where: { id: trackerId },
      select: {
        // The level book is fetched over THIS user's own Angel session — the
        // platform has no shared feed account, so without it every level read
        // comes back empty. See `SentinelChartContextAdapter`'s class note.
        userId: true,
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
        // The freshness of `lastLtp`. There is no dedicated `lastLtpAt` column,
        // and `updatedAt` is the honest proxy: `computeTickPatch` is what writes
        // this row in-session, so its age IS the price's age. It can only ever
        // be NEWER than the price (any other write also touches it), which
        // makes the guard below conservative in the safe direction — it will
        // never call a fresh price stale.
        updatedAt: true,
      },
    });
    if (!row) throw new TickUnavailable(`tracker ${trackerId} no longer exists`);
    return this.tickForRow(trackerId, row, opts);
  }

  /**
   * The whole reading for one position row — everything `tickFor` does after the
   * tracker read. Public for the paper sentinel, which builds the row from a paper
   * trade (no tracker exists) so a paper position is read EXACTLY as a live one is.
   * `uncounted` keeps such reads out of the hub's `positions` consumer counter.
   */
  async tickForRow(
    trackerId: string,
    row: TickRow,
    opts: TickOptions & { uncounted?: boolean } = {},
  ): Promise<TickReading> {
    // SP1 M3 (HUB_PRICES_POSITIONS): the hub's own price for the contract when it
    // serves this user (today: the owner only) and has one ≤ 10 s old. Otherwise
    // the tracker row, with both of its refusals.
    const source = this.hubSource();
    const hub = source?.hubFor(row.userId, 'positions') ?? null;
    const hubLtp = this.hubContractPrice(hub, row);
    // M1: consumers.positions counts only users the hub serves (hub !== null), so the
    // production gate reads the hub's own share and other tenants never confound it.
    const counted = hub && !opts.uncounted ? source : null;
    let ltp: number;
    if (hubLtp !== null) {
      ltp = hubLtp;
      counted?.record('positions', 'hub');
    } else {
      try {
        ltp = this.storedPrice(trackerId, row, opts.closedSession === true);
      } catch (err) {
        counted?.record('positions', 'unpriced');
        throw err;
      }
      counted?.record('positions', 'legacy');
    }

    const segment = segmentFor(row);
    const side = sideFor(row.qty);
    const isCash = segment === 'EQ_DELIVERY' || segment === 'EQ_INTRADAY';

    // Resolved ONCE and used three times below — for the spot, for the level
    // book and for the news. They must all be talking about the same underlying.
    const underlying = isCash ? NO_UNDERLYING : await this.resolveUnderlying(row.exchange, row.token, row.symbol);

    // For cash the contract IS the underlying, so this must be `ltp` and never
    // null — a null silences every level-comparing sensor on every equity
    // position, and does so in a way that looks exactly like "no level was
    // touched". The cycle repairs this defensively too; it is set here so the
    // repair never has to fire.
    //
    // The `at` is the spot's own read time for a derivative, and null for cash —
    // where the underlying IS `ltp`, which carries no timestamp of its own, so
    // the packet's build time is the honest fallback rather than a borrowed one.
    const spot: SpotReading = isCash
      ? { ltp, at: null, source: SPOT_SOURCE_CASH, reason: null }
      : await this.spotFor(underlying, row.userId, row.symbol, hub);
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

    // MCX only: the exact future the spot came from. A NAME alone ('CRUDEOIL')
    // cannot say which month, and a far-month option's book must be its own
    // month's future — so the level book is told the contract, not left to guess.
    const structureInstrument =
      !isCash && underlying.contract && underlying.token && underlying.exchange
        ? { exchange: underlying.exchange, token: underlying.token, symbol: underlying.contract }
        : null;

    // News & events v2 (`true` only): a synchronous peek, never a DB read.
    const v2News = this.newsCfg?.rendering === true && structureSymbol ? this.freshFromIndex(structureSymbol, row.exchange) : null;
    const [structure, legacyNews] = await Promise.all([
      structureSymbol
        ? structureInstrument
          ? this.charts.structureFor(structureSymbol, underlyingLtp, row.userId, structureInstrument)
          : this.charts.structureFor(structureSymbol, underlyingLtp, row.userId)
        : Promise.resolve(NO_STRUCTURE),
      // Null, not 0 — "no reading" and "nothing published" must stay apart.
      structureSymbol
        ? v2News
          ? Promise.resolve({ count: v2News.count, items: null })
          : this.freshNewsLegacy(structureSymbol, row.exchange)
        : Promise.resolve({ count: null, items: null }),
    ]);

    const noise = opts.closedSession ? null : await this.noiseFor(row, isCash, underlying);
    // Equity spec §4: the equity block's market inputs — CASH only, so an F&O tick is unchanged.
    const equityInputs = isCash ? await this.equityInputsFor(trackerId, row, hub) : null;
    const news = mergeImpactNews(opts.closedSession ? [] : (this.impactBook?.freshFor(structureSymbol, Date.now()) ?? []), v2News?.fresh, legacyNews);

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
      // Only the overnight review asks for the print time: overnight `ltp` is the
      // finished session's last price and the packet must say when it was printed.
      ...(opts.closedSession ? { ltpAt: hubLtp !== null ? new Date().toISOString() : row.updatedAt.toISOString() } : {}),
      underlyingLtp,
      underlyingLtpAt: spot.at,
      // WHICH TIER produced it, and — when it produced nothing — which tiers
      // were tried. Threaded rather than written as a constant downstream for
      // the same reason `structureSource` is: the packet builder does not know
      // whether it is holding a live print or a REST snapshot, and provenance
      // that cannot tell them apart is not provenance.
      underlyingLtpSource: spot.source,
      underlyingLtpReason: spot.reason,
      // Executor plumbing for price triggers (never rendered into the packet):
      // the instrument an UNDERLYING exitTrigger watches, and the contract itself.
      underlyingRef:
        !isCash && underlying.token && underlying.exchange
          ? { exchange: underlying.exchange, token: underlying.token, symbol: underlying.contract ?? underlying.name ?? underlying.token }
          : null,
      contractRef: { exchange: String(row.exchange ?? '').toUpperCase(), token: String(row.token), symbol: row.symbol },
      // Carried so the packet builder and the thesis inference look their
      // evidence up by the SAME symbol these sensors did. Resolved once, here;
      // a second resolution downstream is how the two paths came to disagree.
      structureSymbol,
      structureInstrument,
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
      expiry: await this.expiryFor(row.token, row.exchange, segment),
      volumeRatio: structure.volumeRatio,
      freshNewsCount: news.count,
      ...(news.freshNews ? { freshNews: news.freshNews } : {}),
      // Legacy news path: the ids behind the count, so the cycle can tell a NEW
      // headline from a repeat (material-change gating). Only when there is one.
      ...(news.items && news.items.length > 0 ? { freshNewsItems: news.items } : {}),
      // Both come off the SAME `analyze()` the levels above did — the factors
      // are computed as part of scoring a setup, so there is no second call and
      // no window in which the levels and the factors describe different bars.
      factorValues: structure.factorValues,
      factorsReason: structure.factorsReason,
      noise,
      ...(equityInputs ? { equityInputs } : {}),
    };
  }

  /**
   * Exit discipline §3: the contract's and the underlying's noise unit from the
   * hub's tick-built 1-minute bars. Null when discipline is off or no reader is
   * wired (the reader is then never asked). For cash the contract IS the
   * underlying. Never throws — the reader turns a DB failure into no bars.
   */
  private async noiseFor(
    row: { exchange: string; token: string; symbol: string; userId?: string },
    isCash: boolean,
    underlying: Underlying,
  ): Promise<TickReading['noise']> {
    if (!this.discipline?.enabled || !this.minuteBars) return null;
    const now = new Date();
    const [cBars, uBars] = await Promise.all([
      this.minuteBars.recent({ exchange: row.exchange, token: row.token, symbol: row.symbol }, now),
      !isCash && underlying.token && underlying.exchange
        ? this.minuteBars.recent(
            { exchange: underlying.exchange, token: underlying.token, symbol: underlying.contract ?? underlying.name ?? underlying.token },
            now,
          )
        : Promise.resolve([]),
    ]);
    // Equity spec T1: a CASH position without hub bars falls back to its OWN daily ATR14 / √(session
    // minutes) — the fallback the packet already gave `underlying`, now on `contract` too, because
    // for cash the contract IS the underlying. Without it the noise floor, the noise giveback and
    // every N-based rule were off for nearly every stock (few hold a hub slot). F&O: unchanged.
    const contract = noiseFromBars(cBars) ?? (isCash ? await this.cashDailyNoise(row, now) : null);
    const underlying1m = isCash ? contract : noiseFromBars(uBars);
    return {
      contract,
      underlying1m,
      reason: contract
        ? null
        : 'no hub 1-minute bars for this contract in the last 120 minutes (needs MARKET_HUB_ENABLED + HUB_CANDLES_ENABLED and a live feed slot)' +
          (isCash ? ", and no daily ATR14 on the stock's level book to fall back to" : ''),
    };
  }

  /**
   * T1: the stock's daily ATR14 scaled to one minute. Reads the SAME cached level book
   * `structureFor` built a moment ago (60 s cache keyed by symbol, in-flight shared), so it costs
   * no broker call. Null when there is no book or no ATR. Never throws.
   */
  private async cashDailyNoise(row: { exchange: string; symbol: string; userId?: string }, now: Date): Promise<NoiseReading | null> {
    try {
      const book = await this.charts.levelsFor(row.symbol, row.userId);
      const atr = (book?.value as { atr14?: unknown } | null | undefined)?.atr14;
      const session = sessionFor(row.exchange);
      return scaledUnderlyingNoise(typeof atr === 'number' ? atr : null, book?.at ?? now.toISOString(), session.closeMin - session.openMin);
    } catch {
      return null;
    }
  }

  /**
   * Equity spec §4 (F4 gap, F5 relative strength): the stock's day bar, NIFTY now and NIFTY at
   * entry. NO BROKER CALL: synchronous hub / live-level-book peeks and one DB read of the hub's
   * 1-minute bars, kept per position. Each leg is a reading with its provenance or the reason
   * there is none — the packet never renders a missing leg as a zero. Never throws.
   */
  private async equityInputsFor(
    trackerId: string,
    row: { exchange: string; token: string; symbol: string; entryTime: Date },
    hub: HubPrices | null,
  ): Promise<EquityTickInputs> {
    const nifty = INDEX_UNDERLYINGS.NIFTY;
    return {
      day: this.stockDayBar(row, hub),
      nifty: this.niftyNow(hub),
      niftyAtEntry: await this.niftyAtEntry(trackerId, row.entryTime, nifty),
    };
  }

  /**
   * The stock's previous close (and open). Tier 1: the hub's broker-reported day bar, ≤ the LTP
   * bound old. Tier 2: the live level book's prevClose — only when that book is this exchange's
   * (books are keyed by token alone) and ticked today; it carries no open.
   */
  private stockDayBar(row: { exchange: string; token: string; symbol: string }, hub: HubPrices | null): EquityLeg<{ open: number | null; prevClose: number }> {
    const ref = hub ? toHubRef(row.exchange, row.token, row.symbol) : null;
    if (hub && ref) {
      const r = hub.price(ref, { maxAgeMs: LTP_STALENESS_MS });
      const day = r.kind === 'fresh' ? r.price.day : undefined;
      if (r.kind === 'fresh' && day && day.close > 0) {
        return { ok: true, open: day.open > 0 ? day.open : null, prevClose: day.close, at: new Date(r.price.at).toISOString(), source: 'market-hub day bar (broker-reported)' };
      }
    }
    const book = this.levelBooks.getLevels(row.token);
    if (
      book &&
      String(book.exchange ?? '').toUpperCase() === String(row.exchange ?? '').toUpperCase() &&
      Number.isFinite(book.prevClose) &&
      book.prevClose > 0 &&
      istDateOnly(book.lastTickAt) === istDateOnly(new Date())
    ) {
      return { ok: true, open: null, prevClose: book.prevClose, at: book.lastTickAt.toISOString(), source: 'live level book (previous close; no open)' };
    }
    return {
      ok: false,
      reason:
        `no day bar for ${row.symbol}: the hub does not serve it fresh for this user and it is not on the live level book ` +
        "(the tracker's broker quote keeps only the last price)",
    };
  }

  /** NIFTY now: the hub (≤ 10 s, the decision bound), else the live level book (≤ 60 s). */
  private niftyNow(hub: HubPrices | null): EquityLeg<{ ltp: number; prevClose: number | null }> {
    const ref = INDEX_UNDERLYINGS.NIFTY;
    let hubWhy = 'no hub serves this user';
    if (hub) {
      const r = hub.price(ref, { maxAgeMs: HUB_DECISION_MAX_AGE_MS });
      if (r.kind === 'fresh' && r.price.ltp > 0) {
        const pc = r.price.day?.close;
        return { ok: true, ltp: r.price.ltp, prevClose: typeof pc === 'number' && pc > 0 ? pc : null, at: new Date(r.price.at).toISOString(), source: SPOT_SOURCE_HUB.replace('underlying spot', 'NIFTY') };
      }
      hubWhy = r.kind === 'stale' ? `hub NIFTY is ${Math.round(r.ageMs / 1000)} s old` : `hub NIFTY ${r.kind === 'unavailable' ? r.reason : r.kind}`;
    }
    const book = this.levelBooks.getLevels(ref.token);
    if (book && Number.isFinite(book.spot) && book.spot > 0) {
      const age = Date.now() - book.lastTickAt.getTime();
      if (age <= SPOT_STALENESS_MS) {
        return { ok: true, ltp: book.spot, prevClose: book.prevClose > 0 ? book.prevClose : null, at: book.lastTickAt.toISOString(), source: 'live level book (NIFTY live feed tick)' };
      }
      return { ok: false, reason: `${hubWhy}; the live NIFTY level book is ${Math.round(age / 1000)} s old` };
    }
    return { ok: false, reason: `${hubWhy}; NIFTY is not on the live level book` };
  }

  /** NIFTY's 1-minute close at the position's entry, from the hub's stored bars (DB only). */
  private async niftyAtEntry(trackerId: string, entryTime: Date, ref: InstrumentRef): Promise<EquityLeg<{ close: number }>> {
    const when = `${istWallHhmm(entryTime)} IST on ${istDateOnly(entryTime)}`;
    if (!this.minuteBars) return { ok: false, reason: 'no minute-bar reader is wired, so NIFTY at entry cannot be read' };
    const key = `${trackerId}:${entryTime.getTime()}`;
    let hit = this.niftyAnchors.get(key);
    if (!hit || (hit.close === null && Date.now() - hit.at > ANCHOR_MISS_RETRY_MS)) {
      let close: number | null = null;
      try {
        close = await this.minuteBars.closeAt(ref, entryTime);
      } catch {
        close = null;
      }
      hit = { close, at: Date.now() };
      this.niftyAnchors.delete(key);
      this.niftyAnchors.set(key, hit);
      if (this.niftyAnchors.size > 500) this.niftyAnchors.delete(this.niftyAnchors.keys().next().value as string);
    }
    return hit.close !== null
      ? { ok: true, close: hit.close, at: entryTime.toISOString(), source: `hub candles_1m NIFTY bar at entry (${when})` }
      : { ok: false, reason: `no NIFTY 1-minute bar at entry ${when} in candles_1m (the hub stores bars only while it runs)` };
  }

  /** The hub's fresh contract price, or null (no hub for this user, an exchange it does not speak, or not fresh). */
  private hubContractPrice(hub: HubPrices | null, row: { exchange: string; token: string; symbol: string }): number | null {
    const ref = hub ? toHubRef(row.exchange, row.token, row.symbol) : null;
    if (!hub || !ref) return null;
    const r = hub.price(ref, { maxAgeMs: HUB_DECISION_MAX_AGE_MS });
    return r.kind === 'fresh' && r.price.ltp > 0 ? r.price.ltp : null;
  }

  /**
   * The tracker row's price, refusing a missing or stale one (see LTP_STALENESS_MS).
   * Substituting the entry price would report a moving trade as flat.
   */
  private storedPrice(
    trackerId: string,
    row: { symbol: string; lastLtp: number | null; updatedAt: Date },
    closedSession = false,
  ): number {
    const ltp = row.lastLtp;
    if (ltp === null || !Number.isFinite(ltp)) {
      throw new TickUnavailable(
        `no live price on tracker ${trackerId} (${row.symbol}) — the tracker poller has not ` +
          'ticked it yet, or the feed is down',
      );
    }
    const ageMs = Date.now() - row.updatedAt.getTime();
    // The overnight review reads a CLOSED market, where every price is old by
    // definition; it accepts the last print and dates it (see `ltpAt`). The live
    // path keeps the refusal.
    if (!closedSession && ageMs > LTP_STALENESS_MS) {
      throw new TickUnavailable(
        `the price on tracker ${trackerId} (${row.symbol}) is ${Math.round(ageMs / 60_000)} ` +
          `minutes old (last ${ltp} at ${row.updatedAt.toISOString()}), past the ` +
          `${LTP_STALENESS_MS / 60_000}-minute bound. Its token is almost certainly not ` +
          'subscribed to the feed — the primary slot pool is small and the default universe ' +
          'claims it at boot. REFUSING to judge: P&L, the green floor and every tripwire ' +
          'would be computed from a stale price and reported as the market now.',
      );
    }
    return ltp;
  }

  /** Resolved lazily; a miss (no hub in this container) is retried on the next tick. */
  private hubSource(): HubPriceSource | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    return this.hubSourceRef;
  }

  /**
   * The UNDERLYING's spot for a derivative — TIERED, because one tier was never
   * enough and its emptiness was the single most damaging blind spot here.
   *
   * WHAT WENT WRONG. This used to be `levelBooks.getLevels(token)` and nothing
   * else. `getLevels` is a SYNCHRONOUS PEEK into an in-memory map: it answers
   * only for tokens something has already seeded AND is actively ticking, and
   * the live feed seeds a fixed universe — the indices, five major stocks, five
   * commodities (`MAJOR_STOCKS` in packages/shared). Nothing the user actually
   * trades is in it. So for every real position this returned null permanently —
   * not overnight, not on a quiet symbol, but at 11:00 on a live trading day.
   * Every other consumer in this repo (`analyze`, `sr-evidence`, `chartink`, the
   * scanner) reaches for `lazyLoad`, which BUILDS a book; the sentinel alone
   * peeked at one it never asked anybody to create.
   *
   * The damage was disproportionate because ONE null gated FOUR blocks. With no
   * price, `structureFor` returns `LEVEL_BOOK_NO_PRICE` and suppresses both
   * nearest levels even though the book behind them was fine; `levelBreak` has
   * nothing to compare; and the OI capture, which keys off the underlying's
   * scale, never runs. The packet said so honestly every tick — which is the only
   * reason this was diagnosable — but honest blindness is still blindness.
   *
   * THE TIERS, best evidence first:
   *   0. the hub (HUB_PRICES_POSITIONS): the underlying is watched at priority 1
   *      beside the position, so its price is a live tick or a critical-lane
   *      quote ≤ 10 s old;
   *   1. a live feed tick, at most `SPOT_STALENESS_MS` old — the market's own
   *      last print, sub-second when the symbol happens to be subscribed;
   *   2. a FULL-mode broker quote over the position owner's own Angel session —
   *      one call, works for any token in the master, and the tier that actually
   *      rescues the ordinary case.
   *
   * Deliberately NOT a third tier reading the book's replayed 5-minute close.
   * That number exists and is tempting, but it is a bar close wearing a spot's
   * name: it would satisfy every consumer while being minutes stale at exactly
   * the moment a level breaks. A stated absence is worth more than a plausible
   * wrong number — the packet is persisted verbatim and replays forever.
   *
   * Null remains a first-class answer, and `reason` now names which tiers were
   * tried, because "we never asked" and "we asked and the broker declined" are
   * different facts about a position with money on it.
   */
  private async spotFor(
    underlying: Underlying,
    userId: string,
    symbol: string,
    hub: HubPrices | null,
  ): Promise<SpotReading> {
    const underlyingToken = underlying.token;
    if (!underlyingToken) return NO_SPOT;

    // Tier 0 — the hub. A stale or missing hub price falls THROUGH, never returns.
    const hubRef = hub ? toHubRef(underlying.exchange, underlyingToken, underlying.name ?? underlyingToken) : null;
    if (hub && hubRef) {
      const r = hub.price(hubRef, { maxAgeMs: HUB_DECISION_MAX_AGE_MS });
      if (r.kind === 'fresh' && r.price.ltp > 0) {
        return { ltp: r.price.ltp, at: new Date(r.price.at).toISOString(), source: SPOT_SOURCE_HUB, reason: null };
      }
    }

    // Tier 1 — a live tick. See SPOT_STALENESS_MS: a frozen spot is worse than
    // no spot, so a stale book falls THROUGH to the quote rather than returning.
    const book = this.levelBooks.getLevels(underlyingToken);
    if (
      book &&
      Number.isFinite(book.spot) &&
      book.spot > 0 &&
      Date.now() - book.lastTickAt.getTime() <= SPOT_STALENESS_MS
    ) {
      // The TICK time, not now: this reading is allowed to be up to
      // SPOT_STALENESS_MS old, and the packet stamps `at` from it. Reporting the
      // build time would tell the agent a minute-old spot was read this instant.
      return {
        ltp: book.spot,
        at: book.lastTickAt.toISOString(),
        source: SPOT_SOURCE_LIVE,
        reason: null,
      };
    }

    // Tier 2 — a broker quote over the OWNING user's session. There is no shared
    // feed account on this platform, so the tenant is not optional here.
    const quoted = await this.quoteFor(underlyingToken, underlying.exchange ?? 'NSE', userId, symbol);
    if (quoted) return quoted;

    return {
      ltp: null,
      at: null,
      source: SPOT_SOURCE_QUOTE,
      reason:
        "the underlying's price could not be resolved: it is not on the live feed (which " +
        'carries only a fixed universe of indices and major stocks) and a broker quote for it ' +
        `${this.userFeed ? 'failed or returned nothing' : 'was not attempted — no per-user feed is wired'}. ` +
        'This is a FAILURE TO LOOK, not a finding. Levels and OI walls below are on the ' +
        'underlying scale and CANNOT be compared against ltp.',
    };
  }

  /**
   * Tier 2: one FULL-mode quote, memoised for {@link SPOT_QUOTE_TTL_MS}.
   *
   * Never throws — a broker that declines a quote must become a stated absence,
   * exactly like every other evidence source here. Returns null so the caller
   * owns the wording of the absence in one place.
   */
  private async quoteFor(
    token: string,
    exchange: string,
    userId: string,
    symbol: string,
  ): Promise<SpotReading | null> {
    if (!this.userFeed) return null;

    const key = `${exchange}:${token}`;
    const cached = this.quotes.get(key);
    if (cached && Date.now() - cached.at < SPOT_QUOTE_TTL_MS) {
      // The CAPTURE time of the original quote, not this cache hit.
      return { ltp: cached.ltp, at: cached.capturedAt, source: SPOT_SOURCE_QUOTE, reason: null };
    }

    try {
      // The UNDERLYING's own exchange (NSE for NIFTY and stocks, BSE for SENSEX,
      // MCX for a commodity's future), never NFO/BFO, or the broker resolves nothing.
      const tick = await this.userFeed.fetchQuote(userId, token, exchange);
      const ltp = tick?.ltp;
      if (!Number.isFinite(ltp as number) || (ltp as number) <= 0) return null;

      const capturedAt = new Date().toISOString();
      this.quotes.set(key, { at: Date.now(), ltp: ltp as number, capturedAt });
      return { ltp: ltp as number, at: capturedAt, source: SPOT_SOURCE_QUOTE, reason: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `underlying quote failed for ${symbol} (token ${token}): ${message} — the spot, the ` +
          'nearest levels and the OI walls will all be absent for this tick',
      );
      return null;
    }
  }

  /**
   * The underlying behind a derivative, memoised.
   *
   * A resolved answer is cached — the instrument master does not change
   * intraday — and so is a resolved-to-nothing answer, which is a FACT about
   * this contract. A THROW is not cached: caching it would let one bad lookup
   * silence the level sensors for the rest of the process's life.
   *
   * Index underlyings come from market-hub/underlying.ts's one map: index rows
   * are not in the instrument table.
   */
  private async resolveUnderlying(exchange: string, token: string, symbol: string): Promise<Underlying> {
    const key = `${String(exchange ?? '').toUpperCase()}:${token}`;
    const cached = this.underlyings.get(key);
    if (cached) return cached;

    let resolved: Underlying = NO_UNDERLYING;
    try {
      const r = await resolveUnderlyingRef(
        { exchange: exchange ?? '', token, symbol },
        {
          contract: (ex, tok) => this.instruments.getInstrumentByToken(tok, ex || undefined),
          cash: (sym, ex) => this.instruments.getInstrumentBySymbol(sym, ex),
          // MCX: a commodity option has no cash row; its underlying is the
          // nearest future of the SAME master name (CRUDEOIL, never CRUDEOILM).
          // The chart adapter resolves the level book's instrument by the same
          // rule, so the spot and the levels are on one contract's scale.
          future: (name, ex, contractExpiry) => this.nearestFutureFor(name, ex, contractExpiry),
        },
      );
      if (r.name) {
        const ex = r.ref?.exchange ?? null;
        resolved = {
          name: normaliseSymbol(r.name),
          token: r.ref?.token ?? null,
          exchange: ex,
          contract: ex === 'MCX' ? (r.ref?.symbol ?? null) : null,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`could not resolve the underlying for ${symbol}: ${message}`);
      return NO_UNDERLYING;
    }

    if (resolved.name === null) {
      this.warnOnce(
        key,
        `no underlying name on the instrument master for ${symbol} — its level book, its news ` +
          'and its OI walls are all unavailable, so the level, volume and news sensors will ' +
          'stay silent on this position for as long as it is held',
      );
    } else if (resolved.token === null) {
      this.warnOnce(
        key,
        `resolved ${symbol} to underlying ${resolved.name}, but no cash/index instrument ` +
          `${String(exchange ?? '').toUpperCase() === 'MCX' ? 'or live MCX future ' : ''}for it ` +
          '— the level book and news still work, the underlying SPOT does not, so the level ' +
          'and OI sensors stay silent',
      );
    }
    this.underlyings.set(key, resolved);
    return resolved;
  }

  /**
   * The future underlying an MCX contract: on MCX an option is an option ON one
   * month's future, so the right contract is the nearest future (exact master
   * name — CRUDEOIL, never CRUDEOILM) expiring on or after the OPTION'S OWN
   * expiry. Only when no such future exists (or the option's expiry is unknown)
   * does it fall back to the nearest future on or after today.
   */
  private async nearestFutureFor(name: string, exchange: string, contractExpiry: Date | null) {
    const today = startOfLocalDay();
    if (contractExpiry && contractExpiry.getTime() > today.getTime()) {
      const own = await this.instruments.getNearestFuture(name, exchange, contractExpiry);
      if (own) return own;
    }
    return this.instruments.getNearestFuture(name, exchange, today);
  }

  /** One line per contract, not one per tick — this is polled every 30 seconds. */
  private warnOnce(token: string, message: string): void {
    if (this.warnedNoUnderlying.has(token)) return;
    this.warnedNoUnderlying.add(token);
    this.logger.warn(message);
  }

  /** The nearest expiry as 'YYYY-MM-DD', or null for cash (the OI capture key). */
  private async expiryFor(token: string, exchange: string, segment: Segment): Promise<string | null> {
    if (segment !== 'OPT' && segment !== 'FUT') return null;
    try {
      const contract = await this.instruments.getInstrumentByToken(token, String(exchange ?? '').toUpperCase() || undefined);
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
   *
   * NULL, TOO, for an underlying no article can ever be tagged with (an MCX
   * commodity or an index with no headline mapping — see
   * `underlying-news-aliases.ts`). Counting there always returns 0, and a 0
   * is a claim that nothing was published when the truth is that we cannot see.
   */
  private async freshNewsLegacy(
    symbol: string,
    exchange?: string | null,
  ): Promise<{ count: number | null; items: FreshItem[] | null }> {
    const news = newsKeyFor(symbol, exchange);
    if (news.key === null) return { count: null, items: null };
    try {
      const articles = await this.news.getNewsForSymbol(news.key);
      const cutoff = Date.now() - FRESH_NEWS_WINDOW_MS;
      const fresh = articles.filter((a) => a.publishedAt.getTime() >= cutoff);
      // Ids only when the rows carry them (a test double may not): no id, no dedup — the count fallback applies.
      const items = fresh
        .filter((a) => typeof (a as { id?: unknown }).id === 'string')
        .map((a) => ({ id: (a as { id: string }).id, title: String(a.title ?? '') }));
      return { count: fresh.length, items: items.length === fresh.length ? items : null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`fresh-news count failed for ${symbol}: ${message}`);
      return { count: null, items: null };
    }
  }

  /** News & events v2 (`true`): the 30-min own-instrument count and ids from the index — synchronous, no DB. */
  private freshFromIndex(symbol: string, exchange?: string | null): { count: number | null; fresh: FreshItem[] | null } {
    const pos = newsPositionOf(symbol, exchange ?? null, null);
    if ('unresolved' in pos || !this.newsIndex) return { count: null, fresh: null };
    try {
      const p = this.newsIndex.peek(pos, new Date());
      return p.status === 'ok' ? { count: p.freshCount, fresh: p.fresh } : { count: null, fresh: null };
    } catch (err) {
      this.logger.warn(`fresh-news (index) failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      return { count: null, fresh: null };
    }
  }
}
