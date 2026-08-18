import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  COMMODITIES,
  INDICES,
  MAJOR_STOCKS,
  SECTOR_INDICES,
  TIMEFRAMES,
} from '@td/shared/constants';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { AngelOneAdapterService } from './angel-one-adapter.service';
import { MarketDataRepository } from '../repositories/market-data.repository';

/**
 * Persists the DAILY candle series so consumers read it from Postgres instead
 * of the broker.
 *
 * THE PROBLEM THIS EXISTS FOR. The `candles` table held 1m/5m/15m/1h and not a
 * single `1d` row. `LevelBookService.lazyLoad` needs 14 dailies (PDH, PDL,
 * prevClose and atr14 all come from them), finds none, and falls through to a
 * live broker fetch — on EVERY call, for EVERY symbol. Every historical broker
 * call in this codebase is globally serialised behind HISTORICAL_MIN_GAP_MS
 * (350ms; Angel allows 3 req/sec), and that ~3-calls-per-second lane is shared
 * by the charts page, the sentinel's level book, the S/R evidence engine, the
 * asymmetric scanner, the indicator card and the Chartink processor at once. So
 * a slow-changing series that changes once per day was being re-bought out of
 * the scarcest resource the platform has, and it is that — not CPU or memory —
 * which caps how many users and open positions this deployment can carry.
 * Stored once a day, `lazyLoad` never reaches the broker again.
 *
 * SCOPE — WHAT IS COVERED:
 *   - every instrument behind a currently-OPEN trade_tracker, and for a
 *     derivative tracker its UNDERLYING cash row instead of the contract,
 *     because the level book is keyed by the underlying and a level book on an
 *     option's own OHLC would be meaningless;
 *   - the feed's default universe: INDICES, SECTOR_INDICES, MAJOR_STOCKS and
 *     COMMODITIES from packages/shared.
 *
 * WHAT IS DELIBERATELY NOT COVERED: the rest of the ~10,000-row instrument
 * master, and every derivative CONTRACT in its own right. Backfilling the whole
 * master would be ~10,000 serialised calls at 350ms — nearly an hour of holding
 * the only historical channel — and for that hour the charts page, whose reads
 * queue in the same lane, would be starved. Anything outside this set still
 * works exactly as it does today, via `lazyLoad`'s broker fallback; it just
 * doesn't get the benefit. Widening the set is a deliberate act with a known
 * price: each extra instrument is 350ms of the shared lane, once a day.
 */

/** The timeframe consumers actually read. Named once; never a bare '1d'. */
const DAILY = TIMEFRAMES.DAILY;

/**
 * How far back a cold backfill reaches.
 *
 * `lazyLoad` asks for 21 CALENDAR days and then takes the last 14 bars, so a
 * 21-day fetch is exactly break-even and any holiday inside the window leaves
 * it short — a short window is what silently degrades atr14 rather than failing
 * loudly. 45 days buys roughly a fortnight of slack against weekends, exchange
 * holidays and a stretch of downtime.
 */
const BACKFILL_LOOKBACK_DAYS = 45;

/**
 * Bars that must already be stored, inside the window `lazyLoad` itself reads,
 * before an instrument is considered done for the day. 14 is not a round
 * number: it is the atr14 period, i.e. the exact count `lazyLoad` slices.
 */
const REQUIRED_DAILY_BARS = 14;

/** The window `lazyLoad` reads (21 calendar days back from the session open). */
const FRESHNESS_WINDOW_DAYS = 21;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Derivative segment → the cash segment its underlying is listed on. MCX is
 * absent on purpose: there is no cash leg for a commodity future, so an MCX
 * contract stands as its own underlying.
 */
const CASH_EXCHANGE_FOR_DERIVATIVE: Record<string, string> = {
  NFO: 'NSE',
  BFO: 'BSE',
  CDS: 'NSE',
};

interface BackfillTarget {
  symbol: string;
  token: string;
  exchange: string;
  /** Why this instrument is in scope — logged so an operator can see the mix. */
  reason: 'universe' | 'open-tracker';
}

type InstrumentRow = {
  id: string;
  symbol: string;
  token: string;
  exchange: string;
  name: string;
  expiry: Date | null;
};

/** Midnight IST of `now`'s calendar day, expressed as a UTC instant. */
export function istMidnightUtc(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 0, 0, 0, 0) -
      IST_OFFSET_MS,
  );
}

@Injectable()
export class DailyCandleBackfillCron implements OnModuleInit {
  private readonly logger = new Logger(DailyCandleBackfillCron.name);

  /**
   * Guards against two passes overlapping — a boot pass still draining when the
   * 23:45 cron fires, or two cron ticks if a pass ever outlives its interval.
   * Both would double the number of tasks queued in the shared 350ms lane while
   * fetching byte-identical windows, so the second pass costs the charts page
   * real latency and buys nothing.
   */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: MarketDataRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    // DELIBERATELY NOT AWAITED. Nest awaits every `onModuleInit` before
    // `app.listen()`, so awaiting a pass that is by construction serialised at
    // 350ms per instrument would put minutes in front of the port bind — and
    // Render fails a deploy that never opens a port. Detached, the server binds
    // immediately and the dailies land behind it.
    void this.backfillOnBoot().catch((err) => {
      this.logger.warn(
        `Boot daily-candle backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * The boot pass, SKIPPED when today's dailies have already landed.
   *
   * THIS IS A STAMPEDE BREAKER, not an optimisation, and it is the same lesson
   * the instrument-master refresh learned the hard way: a boot job whose cost is
   * paid again on every restart turns a crash loop into a self-feeding one. Here
   * the cost is broker calls in the one globally-serialised historical lane, so
   * a container flapping through restarts would monopolise that lane against
   * live chart traffic while re-fetching a series that had not changed. Owning
   * the daily fill is the 23:45 cron's job; boot only exists to cover the case
   * where the process was down when the cron should have fired.
   */
  private async backfillOnBoot(): Promise<void> {
    try {
      const newest = await this.prisma.candle.findFirst({
        where: { timeframe: DAILY },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true },
      });
      const todayIst = istMidnightUtc(new Date());
      if (newest && newest.timestamp.getTime() >= todayIst.getTime()) {
        this.logger.log(
          `Skipping boot daily backfill — newest stored ${DAILY} candle is ` +
            `${newest.timestamp.toISOString()}, already on or after today's IST midnight. ` +
            'The 23:45 IST cron owns the daily fill; re-running it on every restart would ' +
            'spend the shared 350ms historical lane re-fetching an unchanged series.',
        );
        return;
      }
    } catch (err) {
      // A failed freshness probe must not SKIP the pass — an empty candle table
      // is precisely the state this hook was added for. Fall through and run.
      this.logger.warn(
        `Could not read the newest stored daily candle, backfilling anyway: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.run('boot');
  }

  /**
   * 23:45 IST Mon-Fri. Late on purpose: MCX trades until 23:30, so an
   * equity-close slot would store a HALF-FORMED commodity daily — and because
   * the per-instrument skip then sees a bar for today, that truncated high/low
   * would never be corrected and would feed PDH/PDL all of the next session.
   * Still comfortably ahead of the 08:00 master refresh and the 09:15 open.
   */
  @Cron('0 45 23 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async runDaily(): Promise<void> {
    await this.run('daily');
  }

  /**
   * A whole pass. NEVER THROWS: this is reached from the scheduler and from a
   * detached boot promise, where an escaping rejection is an unhandled one, and
   * one dead instrument (delisted token, rolled contract, broker hiccup) must
   * not cost the other fifty their fill.
   */
  async run(trigger: string): Promise<void> {
    if (this.running) {
      this.logger.log(
        `Daily backfill (${trigger}) skipped — a pass is already in flight; ` +
          'a second one would double-queue the shared historical lane for identical windows',
      );
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    let filled = 0;
    let skipped = 0;
    let failed = 0;
    let inserted = 0;

    try {
      const targets = await this.resolveTargets();
      this.logger.log(
        `Daily candle backfill starting (${trigger}): ${targets.length} instruments ` +
          `(${targets.filter((t) => t.reason === 'open-tracker').length} behind open trackers)`,
      );

      for (const target of targets) {
        try {
          const count = await this.backfillOne(target);
          if (count === null) skipped += 1;
          else {
            filled += 1;
            inserted += count;
          }
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `Daily backfill failed for ${target.exchange}:${target.symbol} — ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Daily candle backfill (${trigger}) aborted while resolving targets: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }

    this.logger.log(
      `Daily candle backfill complete (${trigger}) in ` +
        `${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
        `fetched=${filled} skipped=${skipped} failed=${failed} rowsInserted=${inserted}`,
    );
  }

  /**
   * The bounded set, de-duplicated by (exchange, token).
   *
   * Open trackers come FIRST so that if a pass is cut short (deploy, restart)
   * the instruments someone has live money in are the ones that got filled.
   */
  private async resolveTargets(): Promise<Array<BackfillTarget & { instrumentId: string }>> {
    const out: Array<BackfillTarget & { instrumentId: string }> = [];
    const seen = new Set<string>();

    const push = (row: InstrumentRow, reason: BackfillTarget['reason']) => {
      const key = `${row.exchange}:${row.token}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        symbol: row.symbol,
        token: row.token,
        exchange: row.exchange,
        instrumentId: row.id,
        reason,
      });
    };

    for (const tracker of await this.openTrackerInstruments()) push(tracker, 'open-tracker');
    for (const universe of await this.universeInstruments()) push(universe, 'universe');

    return out;
  }

  /**
   * Instruments behind currently-OPEN trackers, with derivatives mapped to
   * their underlying cash row.
   *
   * The mapping is the point. A tracker on `KEI29SEP265800CE` is a position in
   * KEI, and the level book is keyed by the underlying — PDH/PDL/atr14 taken
   * from an option contract's own thin, decaying OHLC describes nothing anyone
   * trades against. Angel's master puts the underlying in `name` (see
   * master-contract.ts), which is what makes the hop possible at all.
   */
  private async openTrackerInstruments(): Promise<InstrumentRow[]> {
    const trackers = await this.prisma.tradeTracker.findMany({
      where: { status: 'OPEN' },
      select: { token: true, exchange: true, symbol: true },
    });

    const rows: InstrumentRow[] = [];
    for (const tracker of trackers) {
      const instrument = await this.findInstrument({
        token: tracker.token,
        exchange: tracker.exchange,
      });
      if (!instrument) {
        this.logger.debug(
          `Open tracker ${tracker.exchange}:${tracker.symbol} has no instrument row — ` +
            'nothing to key daily candles by, skipping',
        );
        continue;
      }
      rows.push((await this.toUnderlying(instrument)) ?? instrument);
    }
    return rows;
  }

  /**
   * The cash row a derivative contract resolves to, or null when the contract
   * IS its own underlying (MCX) or the cash row is missing from the master.
   * A missing cash row is not an error — the caller falls back to the contract,
   * which is still better than no daily series at all.
   */
  private async toUnderlying(instrument: InstrumentRow): Promise<InstrumentRow | null> {
    if (!instrument.expiry) return null;
    const cashExchange = CASH_EXCHANGE_FOR_DERIVATIVE[instrument.exchange];
    if (!cashExchange) return null;
    return this.prisma.instrument.findFirst({
      where: { symbol: instrument.name, exchange: cashExchange, expiry: null },
      select: { id: true, symbol: true, token: true, exchange: true, name: true, expiry: true },
    });
  }

  /**
   * The feed's default universe. Resolved by token first and by symbol second:
   * MCX commodity tokens roll every month, so the constant's token goes stale
   * between rolls while the instrument row's does not (CommodityRollCron keeps
   * it current) — matching on symbol is what survives the roll.
   */
  private async universeInstruments(): Promise<InstrumentRow[]> {
    const wanted = [
      ...Object.values(INDICES),
      ...Object.values(SECTOR_INDICES),
      ...Object.values(MAJOR_STOCKS),
      ...Object.values(COMMODITIES),
    ] as Array<{ symbol: string; token: string; exchange: string }>;

    const rows: InstrumentRow[] = [];
    for (const entry of wanted) {
      const instrument = await this.findInstrument(entry);
      if (!instrument) {
        this.logger.debug(
          `Universe symbol ${entry.exchange}:${entry.symbol} has no instrument row — skipping`,
        );
        continue;
      }
      rows.push(instrument);
    }
    return rows;
  }

  private async findInstrument(entry: {
    token: string;
    exchange: string;
    symbol?: string;
  }): Promise<InstrumentRow | null> {
    const select = {
      id: true,
      symbol: true,
      token: true,
      exchange: true,
      name: true,
      expiry: true,
    };
    const byToken = await this.prisma.instrument.findFirst({
      where: { token: entry.token, exchange: entry.exchange },
      select,
    });
    if (byToken || !entry.symbol) return byToken;
    return this.prisma.instrument.findFirst({
      where: { symbol: entry.symbol, exchange: entry.exchange },
      select,
    });
  }

  /**
   * Fill one instrument. Returns the number of rows written, or null when the
   * instrument was already current and no broker call was made.
   */
  private async backfillOne(
    target: BackfillTarget & { instrumentId: string },
  ): Promise<number | null> {
    const now = new Date();
    const todayIst = istMidnightUtc(now);
    const windowStart = new Date(todayIst.getTime() - FRESHNESS_WINDOW_DAYS * MS_PER_DAY);

    const stored = await this.prisma.candle.findMany({
      where: {
        instrumentId: target.instrumentId,
        timeframe: DAILY,
        timestamp: { gte: windowStart },
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });
    const newest = stored[0]?.timestamp ?? null;

    // SKIP RULE, and both halves matter. Depth alone is not enough — a series
    // that stops last Tuesday still has 14 bars and would hand `lazyLoad` a
    // stale PDH. Recency alone is not enough either — an instrument added to a
    // tracker yesterday has exactly one bar and needs the deep fill. Only an
    // instrument that is BOTH deep enough for atr14 and current as of today is
    // genuinely done, and skipping it is what keeps a daily pass cheap enough
    // to keep running as the tracked set grows.
    if (
      stored.length >= REQUIRED_DAILY_BARS &&
      newest &&
      newest.getTime() >= todayIst.getTime()
    ) {
      return null;
    }

    // Refetch from the newest stored bar when the series is already deep, and
    // reach the full lookback when it is not. The incremental case is the
    // common one and keeps the response small; skipDuplicates makes the overlap
    // on the boundary bar free.
    const from =
      stored.length >= REQUIRED_DAILY_BARS && newest
        ? newest
        : new Date(now.getTime() - BACKFILL_LOOKBACK_DAYS * MS_PER_DAY);

    // 'background' priority, NOT 'interactive'. The adapter drains interactive
    // first and only falls to background when that lane is empty, so a chart
    // request arriving mid-pass jumps the whole remaining backfill instead of
    // waiting behind it. A bulk fill that made a user's chart wait would have
    // traded one latency problem for another.
    const rows = await this.adapter.getHistoricalData(
      target.token,
      target.exchange,
      DAILY,
      from,
      now,
      'background',
    );

    if (!rows || rows.length === 0) {
      this.logger.debug(
        `${target.exchange}:${target.symbol} — broker returned no ${DAILY} candles from ${from.toISOString()}`,
      );
      return 0;
    }

    // createMany + skipDuplicates against the (instrumentId, timeframe,
    // timestamp) unique constraint: re-running the pass, or overlapping the
    // boundary bar, can only ever be a no-op.
    return this.repo.saveCandles(
      rows.map((c: any) => ({
        instrumentId: target.instrumentId,
        timeframe: DAILY,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 0,
      })),
    );
  }
}
