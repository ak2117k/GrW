import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { NewsAggregatorService } from '../../news/services/news-aggregator.service';
import type { Segment, Side } from '../charges';
import type { TickReading, TickSource } from '../services/sentinel-cycle.service';
import { SentinelChartContextAdapter } from './chart-context.adapter';
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
 */
@Injectable()
export class SentinelTickSource implements TickSource {
  private readonly logger = new Logger(SentinelTickSource.name);

  /** Resolved underlying token per instrument token — the master does not change intraday. */
  private readonly underlyingToken = new Map<string, string | null>();

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

    // For cash the contract IS the underlying, so this must be `ltp` and never
    // null — a null silences every level-comparing sensor on every equity
    // position, and does so in a way that looks exactly like "no level was
    // touched". The cycle repairs this defensively too; it is set here so the
    // repair never has to fire.
    const underlyingLtp = isCash ? ltp : await this.spotFor(row.token, row.symbol);

    const [structure, freshNewsCount] = await Promise.all([
      this.charts.structureFor(row.symbol, underlyingLtp),
      this.freshNewsCount(row.symbol),
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
      nearestSupport: structure.nearestSupport,
      nearestResistance: structure.nearestResistance,
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
  private async spotFor(token: string, symbol: string): Promise<number | null> {
    const underlying = await this.resolveUnderlying(token, symbol);
    if (!underlying) return null;

    const book = this.levelBooks.getLevels(underlying);
    if (!book || !Number.isFinite(book.spot) || book.spot <= 0) return null;
    // See SPOT_STALENESS_MS — a frozen spot is worse than no spot.
    if (Date.now() - book.lastTickAt.getTime() > SPOT_STALENESS_MS) return null;
    return book.spot;
  }

  /** The underlying's NSE token, memoised. `null` is cached too — it will not change today. */
  private async resolveUnderlying(token: string, symbol: string): Promise<string | null> {
    if (this.underlyingToken.has(token)) return this.underlyingToken.get(token) ?? null;

    let resolved: string | null = null;
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
        resolved = cash?.token ?? null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`could not resolve the underlying for ${symbol}: ${message}`);
      // NOT cached: this is a failure, not a fact, and caching it would make one
      // bad lookup silence the level sensors for the rest of the process's life.
      return null;
    }

    if (resolved === null) {
      this.logger.warn(
        `no NSE underlying found for ${symbol} — its levels and OI walls stay unavailable, ` +
          'so the level and OI sensors will correctly stay silent on this position',
      );
    }
    this.underlyingToken.set(token, resolved);
    return resolved;
  }

  /** The nearest expiry as 'YYYY-MM-DD', or null for cash (the OI capture key). */
  private async expiryFor(token: string, segment: Segment): Promise<string | null> {
    if (segment !== 'OPT' && segment !== 'FUT') return null;
    try {
      const contract = await this.instruments.getInstrumentByToken(token);
      const expiry = contract?.expiry;
      if (!expiry) return null;
      return expiry.toISOString().slice(0, 10);
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
