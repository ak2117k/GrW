import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { LevelBook, SeedSessionInput, TickInput } from '../types/level-book.types';
import { InstrumentService } from '../../market-data/services/instrument.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { BrokerAdapter } from '../../../common/interfaces/broker-adapter.interface';
import { HistoricalPriority } from '../../market-data/services/angel-one-adapter.service';
import type { CandleSource } from './candle-source';
import { TIMEFRAMES } from '@td/shared/constants';

// Use the literal injection token string instead of importing
// BROKER_ADAPTER_TOKEN from market-feed.service — that import creates
// a circular load order (market-feed imports LevelBookService for the
// live tick path, LevelBookService importing back through it crashes
// the watcher at boot). The string is the source of truth either way.
const BROKER_ADAPTER_TOKEN = 'BROKER_ADAPTER';

const STALE_THRESHOLD_MS = 60_000;
const LAZY_FRESH_MS = 5 * 60 * 1000;
const ATR_PERIOD = 14;
const DEFAULT_ROUND_STEP: Record<string, number> = {
  NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25,
};
const DEFAULT_FALLBACK_STEP = 50;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The UTC moment that corresponds to **today 00:00 IST**. Angel One stamps
 * daily candles at midnight IST of the trading day they represent — which
 * is 18:30 UTC of the *previous* calendar day. So the candle for trading
 * day 2026-04-30 is timestamped `2026-04-29 18:30 UTC`.
 *
 * To pick "yesterday or earlier" while excluding "today's still-forming
 * daily candle," compare with strict `<` against this value. Naive
 * thresholds like "today's session open" (03:45 UTC for NSE) do NOT work
 * because today's daily candle (stamped at 18:30 UTC yesterday) is
 * *before* today's session open and would slip through.
 *
 * Exported because both `LevelBookService.lazyLoad` and `LevelBookCron.
 * seedSession` need the same threshold.
 */
export function getTodayMidnightIstAsUtc(now: Date = new Date()): Date {
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const todayMidnightIst = Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    0, 0, 0, 0,
  );
  return new Date(todayMidnightIst - IST_OFFSET_MS);
}

interface BookState extends LevelBook {
  /** Internal accumulators for VWAP. */
  cumPV: number;
  cumV: number;
  /**
   * Timestamp of the most-recent daily candle that fed PDH/PDL/atr14. Used by
   * lazyLoad to detect when a newer daily has landed in the DB after seed
   * time (boot-after-downtime → gap-fill ingests yesterday on demand) and
   * refresh the static side without dropping the live VWAP / today's H/L /
   * opening-range that the tick path is accumulating.
   */
  lastDailyTimestamp: Date | null;
}

@Injectable()
export class LevelBookService {
  private readonly logger = new Logger(LevelBookService.name);
  private readonly books = new Map<string, BookState>();
  /**
   * Tokens whose books are kept current by the live tick path
   * (seeded by the cron, then updated on every WS tick via
   * MarketFeedService.updateFromTick). For these, lazyLoad can return
   * the cached book without rebuilding from DB — the in-memory book
   * is fresher than any DB snapshot would be.
   */
  private readonly liveBooks = new Set<string>();
  /** Per-user candle-fetch failures already warned about — see warnOnce. */
  private readonly warnedFetchKeys = new Set<string>();

  constructor(
    @Optional() private readonly instrumentService?: InstrumentService,
    @Optional() private readonly marketDataRepository?: MarketDataRepository,
    @Optional() @Inject(BROKER_ADAPTER_TOKEN) private readonly brokerAdapter?: BrokerAdapter | null,
  ) {}

  /** Cron + boot path call this so lazyLoad knows to trust the in-memory book. */
  markAsLive(token: string): void {
    this.liveBooks.add(token);
  }

  /**
   * Replay the most-recent session's 5m candles into a freshly-seeded
   * book to populate VWAP / todayHigh / todayLow / OR. Without this, a
   * book seeded by the cron has correct PDH/PDL/ATR (from daily candles)
   * but VWAP=0 and todayH/L=0 until the first live tick — which during
   * overnight is hours away. This routine fills in the gap from DB.
   *
   * "Most-recent session" definition: if `now` is past today's open,
   * use today's session; otherwise (overnight gap) use yesterday's. So
   * a chart opened at 02:00 IST shows yesterday's session VWAP, and
   * one opened at 11:00 IST shows today's accumulating session VWAP.
   */
  async replaySessionToBook(token: string, exchange: string, instrumentId: string): Promise<void> {
    if (!this.marketDataRepository) return;

    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const isMcx = exchange === 'MCX';
    const openH = isMcx ? 9 : 9;
    const openM = isMcx ? 0 : 15;
    const todayOpenIst = new Date(Date.UTC(
      istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(),
      openH, openM, 0, 0,
    ));
    const todayOpenUtc = new Date(todayOpenIst.getTime() - istOffsetMs);
    const sessionStart = now.getTime() >= todayOpenUtc.getTime()
      ? todayOpenUtc
      : new Date(todayOpenUtc.getTime() - 24 * 3600 * 1000);

    const fiveMinRows = await this.marketDataRepository.getCandles(
      instrumentId, TIMEFRAMES.FIVE_MIN, sessionStart, now,
    );

    if (fiveMinRows.length >= 3 && this.books.has(token)) {
      const orBars = fiveMinRows.slice(0, 3);
      const orHigh = Math.max(...orBars.map((b) => b.high));
      const orLow = Math.min(...orBars.map((b) => b.low));
      this.lockOpeningRange(token, { high: orHigh, low: orLow });
    }

    for (const bar of fiveMinRows) {
      this.updateFromTick({
        token,
        ltp: bar.close,
        volume: typeof bar.volume === 'bigint' ? Number(bar.volume) : bar.volume,
        timestamp: bar.timestamp,
      });
    }
  }

  seedSession(input: SeedSessionInput): void {
    const candles = [...input.recentDailyCandles].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    if (candles.length === 0) {
      this.logger.warn(`seedSession: no candles for ${input.symbol}, skipping`);
      return;
    }
    const last = candles[candles.length - 1];
    const atr14 = this.computeAtr(candles);

    const existing = this.books.get(input.token);
    const book: BookState = {
      token: input.token,
      symbol: input.symbol,
      exchange: input.exchange,
      asOf: new Date(),
      pdh: last.high,
      pdl: last.low,
      prevClose: last.close,
      // Preserve OR + intraday accumulators across a re-seed so an
      // in-session refresh (lazyLoad detected a newer daily candle)
      // doesn't blow away the VWAP / today's H/L the tick path has
      // been building.
      orh: existing?.orh ?? null,
      orl: existing?.orl ?? null,
      orLocked: existing?.orLocked ?? false,
      // Preserve previous-session OR across a re-seed; lazyLoad recomputes
      // it explicitly when it has the broker/DB context to do so.
      prevOrh: existing?.prevOrh ?? null,
      prevOrl: existing?.prevOrl ?? null,
      spot: existing?.spot ?? 0,
      vwap: existing?.vwap ?? 0,
      todayHigh: existing?.todayHigh ?? 0,
      todayLow: existing?.todayLow ?? 0,
      atr14,
      lastTickAt: existing?.lastTickAt ?? new Date(0),
      roundNumbers: existing?.roundNumbers ?? [],
      cumPV: existing?.cumPV ?? 0,
      cumV: existing?.cumV ?? 0,
      lastDailyTimestamp: last.timestamp,
    };
    this.books.set(input.token, book);
  }

  updateFromTick(tick: TickInput): void {
    const book = this.books.get(tick.token);
    if (!book) return; // not seeded; ignore silently

    book.spot = tick.ltp;
    if (book.todayHigh === 0 || tick.ltp > book.todayHigh) book.todayHigh = tick.ltp;
    if (book.todayLow === 0 || tick.ltp < book.todayLow) book.todayLow = tick.ltp;

    if (tick.volume > 0) {
      book.cumPV += tick.ltp * tick.volume;
      book.cumV += tick.volume;
      book.vwap = book.cumPV / book.cumV;
    }

    book.lastTickAt = tick.timestamp;
    book.roundNumbers = this.computeRoundNumbers(book.symbol, tick.ltp);
  }

  lockOpeningRange(token: string, or: { high: number; low: number }): void {
    const book = this.books.get(token);
    if (!book) return;
    if (book.orLocked) return; // idempotent
    book.orh = or.high;
    book.orl = or.low;
    book.orLocked = true;
  }

  getLevels(token: string): LevelBook | null {
    const book = this.books.get(token);
    if (!book) return null;
    // Strip internal accumulators from the public view
    const { cumPV: _pv, cumV: _v, lastDailyTimestamp: _ldt, ...publicBook } = book;
    void _pv; void _v; void _ldt;
    return publicBook;
  }

  isStale(token: string): boolean {
    const book = this.books.get(token);
    if (!book) return true;
    return Date.now() - book.lastTickAt.getTime() > STALE_THRESHOLD_MS;
  }

  setTopVolStrikes(token: string, strikes: number[]): void {
    const book = this.books.get(token);
    if (!book) return;
    book.topVolStrikes = strikes;
  }

  /**
   * Drop the in-memory book for a token so the next read rebuilds from the
   * DB. Call this after a manual catch-up (debug-broker-fetch) that
   * upserted new daily candles — without it, the chart keeps serving the
   * pre-catch-up PDH/PDL because the cached book was seeded from stale DB
   * rows. The live-fed `liveBooks` membership is preserved so the WS path
   * doesn't lose its tick stream subscription on next tick.
   */
  invalidate(token: string): boolean {
    const had = this.books.delete(token);
    if (had) {
      this.logger.debug(`invalidate(${token}): cleared in-memory book — next read will rebuild from DB`);
    }
    return had;
  }

  /**
   * Force-refresh daily statics (PDH/PDL/prevClose/atr14) from the broker
   * directly, ignoring whatever's in the DB. Live intraday accumulators
   * (VWAP, today's H/L, OR, cumPV/cumV, lastTickAt) are preserved across
   * the re-seed thanks to seedSession's intraday-preservation logic.
   *
   * Used by `analyze()` to make the chart's Setup card self-healing —
   * every analysis request gets fresh PDH/PDL/atr14 from Angel, which
   * eliminates the staleness vector that the level-book cache + DB path
   * could otherwise introduce (cron didn't fire, contract rolled, etc.).
   *
   * Returns the refreshed public book, or null if the broker fetch
   * failed / didn't return enough daily candles for ATR. On null, the
   * caller should fall back to the existing `lazyLoad` path which
   * tolerates partial data.
   *
   * `source` (optional) is the caller's own per-request candle source — see
   * candle-source.ts. Omit it and this behaves exactly as before, on the shared
   * adapter.
   */
  async refreshFromBroker(
    token: string,
    exchange: string,
    symbol: string,
    source?: CandleSource,
  ): Promise<LevelBook | null> {
    // A per-request source is a broker of its own, so the shared adapter is
    // only a hard requirement when there isn't one.
    if (!source && !this.brokerAdapter?.getHistoricalData) return null;

    const now = new Date();
    const sessionOpen = getTodayMidnightIstAsUtc(now);
    const dailyFrom = new Date(sessionOpen.getTime() - 30 * 24 * 60 * 60 * 1000);

    try {
      const brokerDaily = await this.fetchHistorical(
        token,
        exchange,
        '1d',
        dailyFrom,
        sessionOpen,
        undefined,
        source,
      );
      const dailyCandles = brokerDaily
        .filter((c: { timestamp: Date | string }) => new Date(c.timestamp).getTime() < sessionOpen.getTime())
        .slice(-21) // keep last 21 closed daily bars; computeAtr only needs 14
        .map((c: { timestamp: Date | string; open: number; high: number; low: number; close: number; volume: number }) => ({
          timestamp: new Date(c.timestamp),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume) || 0,
        }));

      if (dailyCandles.length < 14) {
        this.logger.debug(
          `refreshFromBroker: ${symbol} returned only ${dailyCandles.length} daily candles, need ≥14`,
        );
        return null;
      }

      this.seedSession({ token, symbol, exchange, recentDailyCandles: dailyCandles });
      return this.getLevels(token);
    } catch (err) {
      this.logger.warn(
        `refreshFromBroker(${symbol}): broker daily fetch failed — ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /**
   * `source` (optional) is the caller's own per-request candle source — see
   * candle-source.ts. It is tried ahead of the shared adapter on each of the
   * three broker fallbacks below (daily statics, today's 5m bars, previous
   * session's OR). Omit it and every one of those is byte-identical to before.
   */
  async lazyLoad(
    token: string,
    exchange: string,
    symbol: string,
    priority: HistoricalPriority = 'background',
    source?: CandleSource,
  ): Promise<LevelBook | null> {
    const cached = this.books.get(token);

    // Live-fed books (universe symbols updated by the WS tick path) are
    // always fresher than any DB rebuild — return them directly without
    // the LAZY_FRESH_MS staleness check. This makes the chart analysis
    // reflect tick-by-tick reality during market hours and retains the
    // in-session VWAP/today's-H-L through overnight (when the lazy-build
    // path would otherwise rebuild and reset them to 0 because the new
    // session hasn't started yet).
    // EXCEPTION before unconditional return: if a newer daily candle has
    // landed in the DB since we seeded (boot-after-downtime, manual
    // backfill via debug-broker-fetch, etc.), refresh the static side
    // (PDH/PDL/prevClose/atr14) before returning. The updated seedSession
    // preserves OR / VWAP / today's H/L across the refresh.
    if (cached && this.liveBooks.has(token)) {
      await this.refreshDailyStaticsIfStale(cached, exchange, symbol);
      const refreshed = this.books.get(token) ?? cached;
      const { cumPV: _pv, cumV: _v, lastDailyTimestamp: _ldt, ...publicBook } = refreshed;
      void _pv; void _v; void _ldt;
      return publicBook;
    }

    // Non-live (lazy-built) books still use the 5-min TTL — the snapshot
    // they were built from is only as fresh as the DB at build time.
    if (cached && Date.now() - cached.lastTickAt.getTime() < LAZY_FRESH_MS) {
      const { cumPV: _pv, cumV: _v, lastDailyTimestamp: _ldt, ...publicBook } = cached;
      void _pv; void _v; void _ldt;
      return publicBook;
    }

    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const sessionOpenIst = new Date(
      Date.UTC(
        istNow.getUTCFullYear(),
        istNow.getUTCMonth(),
        istNow.getUTCDate(),
        9, 15, 0, 0,
      ),
    );
    const sessionOpen = new Date(sessionOpenIst.getTime() - istOffsetMs);

    // Resolve via DB when seeded (universe symbols), else fall through to
    // broker historical API. Either path produces a populated LevelBook.
    const instrument = this.instrumentService
      ? await this.instrumentService.getByToken(token)
      : null;

    let dailyCandles: Array<{
      timestamp: Date; open: number; high: number; low: number; close: number; volume: number;
    }> = [];

    if (instrument && this.marketDataRepository) {
      const dailyFrom = new Date(sessionOpen.getTime() - 21 * 24 * 60 * 60 * 1000);
      const dailyRows = await this.marketDataRepository.getCandles(
        instrument.id,
        TIMEFRAMES.DAILY,
        dailyFrom,
        sessionOpen,
      );
      dailyCandles = dailyRows
        .filter((c) => c.timestamp.getTime() < sessionOpen.getTime())
        .slice(-14)
        .map((c) => ({
          timestamp: c.timestamp,
          open: c.open, high: c.high, low: c.low, close: c.close,
          volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
        }));
    }

    // Broker fallback — fires when the local DB doesn't have the symbol
    // (e.g. user searched a stock that isn't in the seeded universe) or
    // doesn't have enough daily candles for ATR.
    if (dailyCandles.length < 14 && (source || this.brokerAdapter?.getHistoricalData)) {
      try {
        const dailyFrom = new Date(sessionOpen.getTime() - 30 * 24 * 60 * 60 * 1000);
        const brokerDaily = await this.fetchHistorical(
          token, exchange, '1d', dailyFrom, sessionOpen, priority, source,
        );
        dailyCandles = brokerDaily
          .filter((c: any) => new Date(c.timestamp).getTime() < sessionOpen.getTime())
          .slice(-14)
          .map((c: any) => ({
            timestamp: new Date(c.timestamp),
            open: Number(c.open), high: Number(c.high),
            low: Number(c.low), close: Number(c.close),
            volume: Number(c.volume) || 0,
          }));
        this.logger.log(
          `lazyLoad: broker fallback fetched ${dailyCandles.length} daily candles for ${symbol} (${exchange})`,
        );
      } catch (err) {
        this.logger.warn(
          `lazyLoad: broker daily fetch failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (dailyCandles.length < 14) {
      this.logger.debug(
        `lazyLoad: ${symbol} has only ${dailyCandles.length} daily candles, need 14`,
      );
      return null;
    }

    this.seedSession({ token, symbol, exchange, recentDailyCandles: dailyCandles });

    // 5m bars for today's session — DB first, broker fallback.
    let fiveMinBars: typeof dailyCandles = [];
    if (instrument && this.marketDataRepository) {
      const fiveMinRows = await this.marketDataRepository.getCandles(
        instrument.id, TIMEFRAMES.FIVE_MIN, sessionOpen, now,
      );
      fiveMinBars = fiveMinRows.map((c) => ({
        timestamp: c.timestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
      }));
    }
    if (fiveMinBars.length === 0 && (source || this.brokerAdapter?.getHistoricalData)) {
      try {
        const broker5m = await this.fetchHistorical(
          token, exchange, '5m', sessionOpen, now, priority, source,
        );
        fiveMinBars = broker5m.map((c: any) => ({
          timestamp: new Date(c.timestamp),
          open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close),
          volume: Number(c.volume) || 0,
        }));
      } catch (err) {
        this.logger.warn(
          `lazyLoad: broker 5m fetch failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (fiveMinBars.length >= 3) {
      const orBars = fiveMinBars.slice(0, 3);
      const orHigh = Math.max(...orBars.map((b) => b.high));
      const orLow = Math.min(...orBars.map((b) => b.low));
      this.lockOpeningRange(token, { high: orHigh, low: orLow });
    }

    for (const bar of fiveMinBars) {
      this.updateFromTick({
        token,
        ltp: bar.close,
        volume: bar.volume,
        timestamp: bar.timestamp,
      });
    }

    // Compute previous trading day's OR for display fallback when today's
    // OR is null. "Previous trading day" = the most recent weekday before
    // today's session open. Fetch first 3 completed 5m bars of that session
    // and compute max(high)/min(low).
    const prevSessionOR = await this.computePrevSessionOR(
      token,
      exchange,
      instrument?.id,
      sessionOpen,
      priority,
      source,
    );
    const cachedBook = this.books.get(token);
    if (cachedBook) {
      cachedBook.prevOrh = prevSessionOR?.orh ?? null;
      cachedBook.prevOrl = prevSessionOR?.orl ?? null;
    }

    return this.getLevels(token);
  }

  /**
   * Walk back up to 5 calendar days from `todaySessionOpen` looking for a
   * session with at least 3 completed 5m bars in its first 15 minutes
   * (09:15–09:30 IST). Returns {orh, orl} = max(high) / min(low) over those
   * 3 bars, or null when nothing was found in the lookback window (long
   * holiday weekends, newly listed instruments, etc.).
   *
   * DB-first, broker fallback. Skips the broker call entirely when DB
   * already has 3 bars — keeps us under the Angel 3 req/sec ceiling.
   */
  private async computePrevSessionOR(
    token: string,
    exchange: string,
    instrumentId: string | undefined,
    todaySessionOpen: Date,
    priority: HistoricalPriority = 'background',
    source?: CandleSource,
  ): Promise<{ orh: number; orl: number } | null> {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    for (let dayOffset = 1; dayOffset <= 5; dayOffset++) {
      const prevDayUtc = new Date(todaySessionOpen.getTime() - dayOffset * 24 * 60 * 60 * 1000);
      const prevIst = new Date(prevDayUtc.getTime() + istOffsetMs);
      const prevSessionOpenIst = new Date(Date.UTC(
        prevIst.getUTCFullYear(), prevIst.getUTCMonth(), prevIst.getUTCDate(),
        9, 15, 0, 0,
      ));
      const prevSessionOROpen = new Date(prevSessionOpenIst.getTime() - istOffsetMs);
      const prevSessionORClose = new Date(prevSessionOROpen.getTime() + 15 * 60 * 1000);

      // Try DB first, broker fallback.
      let bars: Array<{ high: number; low: number }> = [];
      if (instrumentId && this.marketDataRepository) {
        const rows = await this.marketDataRepository.getCandles(
          instrumentId, TIMEFRAMES.FIVE_MIN, prevSessionOROpen, prevSessionORClose,
        );
        bars = rows.map((c) => ({ high: c.high, low: c.low }));
      }
      if (bars.length < 3 && (source || this.brokerAdapter?.getHistoricalData)) {
        try {
          const broker = await this.fetchHistorical(
            token, exchange, '5m', prevSessionOROpen, prevSessionORClose, priority, source,
          );
          bars = broker.map((c: { high: number | string; low: number | string }) => ({
            high: Number(c.high),
            low: Number(c.low),
          }));
        } catch {
          // Quiet — try the next day back.
        }
      }
      if (bars.length >= 3) {
        const orBars = bars.slice(0, 3);
        return {
          orh: Math.max(...orBars.map((b) => b.high)),
          orl: Math.min(...orBars.map((b) => b.low)),
        };
      }
    }
    return null;
  }

  /**
   * Re-seed PDH/PDL/prevClose/atr14 if a newer daily candle has appeared in
   * the DB since this book was seeded. No-op when:
   *   - the dependency is absent (test wiring without market-data)
   *   - the instrument can't be resolved
   *   - no newer daily exists
   *
   * Cheap (~1 indexed `findFirst`) and safe to call on every lazyLoad —
   * the staleness check itself bails fast for the common (already-fresh)
   * case. The actual re-seed only runs when a new daily lands.
   */
  private async refreshDailyStaticsIfStale(
    book: BookState,
    exchange: string,
    symbol: string,
  ): Promise<void> {
    if (!this.instrumentService || !this.marketDataRepository) return;
    const instrument = await this.instrumentService.getByToken(book.token);
    if (!instrument) return;

    const todayMidnightUtc = getTodayMidnightIstAsUtc();
    const latest = await this.marketDataRepository.getLatestCandleBefore(
      instrument.id,
      TIMEFRAMES.DAILY,
      todayMidnightUtc,
    );
    if (!latest) return;
    if (
      book.lastDailyTimestamp !== null &&
      latest.timestamp.getTime() <= book.lastDailyTimestamp.getTime()
    ) {
      return; // already current
    }

    const dailyFrom = new Date(todayMidnightUtc.getTime() - 21 * 24 * 60 * 60 * 1000);
    const rows = await this.marketDataRepository.getCandles(
      instrument.id,
      TIMEFRAMES.DAILY,
      dailyFrom,
      todayMidnightUtc,
    );
    const dailyCandles = rows
      .filter((c) => c.timestamp.getTime() < todayMidnightUtc.getTime())
      .slice(-14)
      .map((c) => ({
        timestamp: c.timestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
      }));
    if (dailyCandles.length === 0) return;

    const prevPdl = book.pdl;
    this.seedSession({
      token: book.token, symbol, exchange, recentDailyCandles: dailyCandles,
    });
    const refreshed = this.books.get(book.token);
    if (refreshed) {
      this.logger.log(
        `refreshDailyStaticsIfStale(${symbol}): pdl ${prevPdl} → ${refreshed.pdl}, ` +
        `pdh → ${refreshed.pdh}, atr14 → ${refreshed.atr14.toFixed(2)} ` +
        `(latest daily: ${refreshed.lastDailyTimestamp?.toISOString()})`,
      );
    }
  }

  /**
   * Historical bars: the caller's own per-request `source` first, the shared
   * broker adapter second.
   *
   * WHY the order: this deployment has NO shared feed account, so on a
   * user-facing request the shared adapter cannot authenticate at all and every
   * call throws. The adapter stays in the chain because the background callers
   * (crons, scanners, workers) have no user context and pass no source.
   *
   * A `source` that throws or returns nothing falls through to the adapter
   * rather than failing the fetch — the caller's existing fallback contract is
   * preserved either way. Adapter errors still propagate, because every call
   * site already has its own catch for them and must keep behaving identically
   * when no source is supplied.
   */
  private async fetchHistorical(
    token: string,
    exchange: string,
    timeframe: string,
    from: Date,
    to: Date,
    priority: HistoricalPriority | undefined,
    source?: CandleSource,
  ): Promise<any[]> {
    if (source) {
      try {
        const rows = await source.getCandles(token, exchange, timeframe, from, to);
        if (Array.isArray(rows) && rows.length > 0) return rows;
      } catch (err) {
        this.warnOnce(
          `${token}:${timeframe}`,
          `levelBook: per-user ${timeframe} fetch failed for ${token} — falling back to the shared adapter: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (!this.brokerAdapter?.getHistoricalData) return [];
    // Preserve the exact call arity of the pre-existing sites: the adapter
    // defaults `priority` to 'background', and a caller that never passed one
    // must keep not passing one.
    return priority
      ? this.brokerAdapter.getHistoricalData(token, exchange, timeframe, from, to, priority)
      : this.brokerAdapter.getHistoricalData(token, exchange, timeframe, from, to);
  }

  /**
   * WARN once per key. These fetches sit behind a ~60s chart poll, so an
   * unconditional warn on a persistent outage is a firehose — and pushing such
   * messages down to `debug` to avoid that is exactly how a permanently broken
   * candle path stayed invisible.
   */
  private warnOnce(key: string, message: string): void {
    if (this.warnedFetchKeys.has(key)) return;
    if (this.warnedFetchKeys.size >= 1000) this.warnedFetchKeys.clear();
    this.warnedFetchKeys.add(key);
    this.logger.warn(message);
  }

  /** Wilder-smoothed ATR over the last ATR_PERIOD candles. */
  private computeAtr(
    candles: SeedSessionInput['recentDailyCandles'],
  ): number {
    if (candles.length < 2) return 0;
    const window = candles.slice(-ATR_PERIOD - 1);
    const trs: number[] = [];
    for (let i = 1; i < window.length; i++) {
      const cur = window[i];
      const prev = window[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      trs.push(tr);
    }
    if (trs.length === 0) return 0;
    // Simple SMA of TR over up to ATR_PERIOD bars (good enough; Wilder
    // smoothing converges to SMA over a stable series).
    const sum = trs.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0);
    return sum / Math.min(ATR_PERIOD, trs.length);
  }

  private computeRoundNumbers(symbol: string, spot: number): number[] {
    const step = DEFAULT_ROUND_STEP[symbol.toUpperCase()] ?? DEFAULT_FALLBACK_STEP;
    const center = Math.round(spot / step) * step;
    return [center - 2 * step, center - step, center, center + step, center + 2 * step];
  }
}
