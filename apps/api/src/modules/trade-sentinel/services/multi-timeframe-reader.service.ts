import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { sessionMinuteFilter } from '../../market-hub/candles/session-sql';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { multiTimeframeView, type Bar, type MultiTimeframeView } from './multi-timeframe';

const CACHE_MS = 60_000;
const CACHE_MAX = 200;
/** Rows per timeframe: ~5 sessions of 1m, ~40 of 15m, ~250 daily (MCX sessions are 14.5 h, NSE 6.25 h). */
const TAKE = {
  NSE: { '1m': 2_000, '15m': 1_100 },
  MCX: { '1m': 4_500, '15m': 2_400 },
  '1d': 250,
} as const;
/** Fewer `candles` 1m rows than this and the hub's candles_1m is read instead (it is the live writer). */
const MIN_1M_ROWS = 300;

/**
 * Broker history (correctness review F3, 2026-11-16): our `candles` / `candles_1m` tables are only
 * filled for some names some days — on 16 Nov ADANIGREEN's bars stopped on 11 Nov and PAYTM's on 13 Nov.
 * So the bars are fetched from Angel over the OWNER's session (UserFeedManager.fetchCandles — the
 * per-user path, paced by the session's historical gate), each timeframe on its own refresh cadence:
 * a held symbol costs ~1 call a minute on average. The account is throttled at times (16 Nov), so a
 * partial or failed fetch keeps the previous bars and the staleness guard decides whether they still count.
 * Lookbacks give EMA80 room: 1m 4 days, 15m 30 days, 1d 400 days.
 */
/** Angel's getCandleData interval per timeframe; one window per call stays inside Angel's per-interval range limits (1m 30 d, 15m 200 d, 1d 2000 d). */
export const ANGEL_INTERVAL = { '1m': 'ONE_MINUTE', '15m': 'FIFTEEN_MINUTE', '1d': 'ONE_DAY' } as const;
export const BROKER_FETCH = {
  // 3m EMA80 needs ~300 1m bars (< 1 session); 1h EMA80 needs ~100 hours (~15 sessions) of 15m.
  '1m': { days: 4, refreshMs: 2 * 60_000 },
  '15m': { days: 30, refreshMs: 5 * 60_000 },
  '1d': { days: 400, refreshMs: 6 * 3_600_000 },
} as const;
type BrokerTf = keyof typeof BROKER_FETCH;

type Inst = { id: string; exchange: string; token: string };

/**
 * The broker-history port (bound in TradeSentinelModule to UserFeedManager). A type-only seam: the
 * sentinel's services must never import anything that can reach order placement (structural spec).
 */
export interface BarHistory {
  /** ONE paced getCandleData call for the window (no per-day chunking) — Angel interval names. */
  fetchCandleWindow(userId: string, ref: { token: string; exchange: string }, interval: string, from: Date, to: Date): Promise<unknown>;
}
export const MTF_BAR_HISTORY = 'SENTINEL_MTF_BAR_HISTORY';
type Candle = { timestamp: Date | string; open: number; high: number; low: number; close: number };

/**
 * Loads an UNDERLYING's 1m / 15m / 1d bars and returns the pure {@link multiTimeframeView} read, with
 * the staleness guard on (`now`): a source whose newest bar is older than the session it should cover
 * is reported stale, never read as current.
 *
 * Source per timeframe: the broker (owner's session, cached per cadence) when a userId and the feed
 * manager are available and the fetch returns bars; else the `candles` table (1m falling back to the
 * hub's candles_1m; 15m and 1d also rolled up from candles_1m, whichever series ends newer). Resolution, as the overnight scorecard resolves underlyings:
 *   - an index (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) → its index token row (INDEX_UNDERLYINGS),
 *   - exchange MCX → the nearest live future of that name (symbol ending FUT),
 *   - else the NSE cash line (`<SYM>-EQ`, then `<SYM>`), falling back to an MCX future when no cash line exists.
 * Never throws: null + a warn on failure or no instrument. Served stale-while-revalidate (refresh after 60 s).
 */
@Injectable()
export class MultiTimeframeReaderService {
  private readonly logger = new Logger(MultiTimeframeReaderService.name);
  private readonly views = new Map<string, { at: number; view: MultiTimeframeView }>();
  private readonly refreshing = new Map<string, Promise<MultiTimeframeView | null>>();
  private readonly brokerBars = new Map<string, { at: number; bars: Bar[] }>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(MTF_BAR_HISTORY) private readonly feeds?: BarHistory,
  ) {}

  /**
   * Stale-while-revalidate: the packet never waits on the broker after the first read. A cached view
   * (any age) is returned at once; when it is older than CACHE_MS one background refresh is started.
   * The staleness guard inside the view still says when its bars are too old to use.
   */
  read(symbol: string, exchange: string, userId?: string | null): Promise<MultiTimeframeView | null> {
    const sym = String(symbol ?? '').trim().toUpperCase();
    const ex = String(exchange ?? '').trim().toUpperCase();
    if (!sym) return Promise.resolve(null);
    const key = `${sym}:${ex}`;
    const now = Date.now();
    const hit = this.views.get(key);
    if (hit) {
      if (now - hit.at >= CACHE_MS && !this.refreshing.has(key)) this.refresh(key, sym, ex, userId ?? null, now);
      return Promise.resolve(hit.view);
    }
    const pending = this.refreshing.get(key) ?? this.refresh(key, sym, ex, userId ?? null, now);
    return pending;
  }

  private refresh(key: string, sym: string, ex: string, userId: string | null, at: number): Promise<MultiTimeframeView | null> {
    const p = this.load(sym, ex, userId)
      .then((view) => {
        if (view) {
          this.views.delete(key);
          this.views.set(key, { at, view });
          if (this.views.size > CACHE_MAX) this.views.delete(this.views.keys().next().value as string);
        }
        return view ?? this.views.get(key)?.view ?? null;
      })
      .finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, p);
    return p;
  }

  private async load(sym: string, ex: string, userId: string | null): Promise<MultiTimeframeView | null> {
    try {
      const inst = await this.resolve(sym, ex);
      if (!inst) {
        this.logger.warn(`multi-timeframe: no instrument for ${sym} (${ex || '?'})`);
        return null;
      }
      const take = inst.exchange === 'MCX' ? TAKE.MCX : TAKE.NSE;
      // Sequential: the owner's session paces historical calls anyway; a burst only queues behind the gate.
      const b1 = await this.fromBroker(userId, inst, '1m');
      const b15 = await this.fromBroker(userId, inst, '15m');
      const bd = await this.fromBroker(userId, inst, '1d');
      const m1 = b1 ?? (await this.dbOneMinute(inst, take['1m']));
      const m15 = b15 ?? fresher(await this.bars(inst.id, '15m', take['15m']), await this.hubFifteen(inst, take['15m']));
      const d1 = bd ?? fresher(await this.bars(inst.id, '1d', TAKE['1d']), await this.hubDaily(inst, TAKE['1d']));
      return multiTimeframeView({ exchange: inst.exchange, '1m': m1, '15m': m15, '1d': d1, now: Date.now() });
    } catch (e) {
      this.logger.warn(`multi-timeframe: read failed for ${sym} (${ex || '?'}): ${(e as Error)?.message ?? e}`);
      return null;
    }
  }

  /** Broker bars for one timeframe, cached per BROKER_FETCH cadence; null = use the database. Never throws. */
  private async fromBroker(userId: string | null, inst: Inst, tf: BrokerTf): Promise<Bar[] | null> {
    if (!userId || !this.feeds) return null;
    const key = `${userId}:${inst.exchange}:${inst.token}:${tf}`;
    const now = Date.now();
    const hit = this.brokerBars.get(key);
    if (hit && now - hit.at < BROKER_FETCH[tf].refreshMs) return hit.bars;
    try {
      const from = new Date(now - BROKER_FETCH[tf].days * 86_400_000);
      const rows = ((await this.feeds.fetchCandleWindow(userId, { token: inst.token, exchange: inst.exchange }, ANGEL_INTERVAL[tf], from, new Date(now))) ?? []) as Candle[];
      const bars: Bar[] = rows
        .map((c) => ({ ts: new Date(c.timestamp).getTime(), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
        .filter((b) => Number.isFinite(b.ts));
      // A throttled fetch can come back short: keep whichever series reaches further back AND is not older at its end.
      const keep = hit && hit.bars.length > bars.length && (bars.length === 0 || hit.bars[hit.bars.length - 1].ts >= bars[bars.length - 1].ts) ? hit.bars : bars;
      if (keep.length === 0) return null;
      this.brokerBars.set(key, { at: now, bars: keep });
      if (this.brokerBars.size > 600) this.brokerBars.delete(this.brokerBars.keys().next().value as string);
      return keep;
    } catch (e) {
      const w = `${inst.token}:${tf}`;
      if (!this.warned.has(w)) {
        this.warned.add(w);
        this.logger.warn(`multi-timeframe: broker ${tf} fetch failed for ${inst.exchange}:${inst.token} (using stored bars): ${(e as Error)?.message ?? e}`);
      }
      return hit?.bars ?? null;
    }
  }

  private async dbOneMinute(inst: Inst, take: number): Promise<Bar[]> {
    const m1 = await this.bars(inst.id, '1m', take);
    if (m1.length >= MIN_1M_ROWS) return m1;
    const h = await this.hubBars(inst, take);
    return h.length > m1.length ? h : m1;
  }

  private async resolve(sym: string, ex: string): Promise<Inst | null> {
    const idx = INDEX_UNDERLYINGS[sym];
    if (idx) {
      return this.prisma.instrument.findFirst({ where: { token: idx.token, exchange: idx.exchange }, select: { id: true, exchange: true, token: true } });
    }
    if (ex === 'MCX') return this.mcxFuture(sym);
    const rows = await this.prisma.instrument.findMany({
      where: { exchange: 'NSE', symbol: { in: [`${sym}-EQ`, sym] } },
      select: { id: true, symbol: true, exchange: true, token: true },
    });
    const r = rows.find((x) => x.symbol === `${sym}-EQ`) ?? rows[0];
    if (r) return { id: r.id, exchange: r.exchange, token: r.token };
    return this.mcxFuture(sym);
  }

  private mcxFuture(name: string): Promise<Inst | null> {
    return this.prisma.instrument.findFirst({
      where: { name, exchange: 'MCX', optionType: null, symbol: { endsWith: 'FUT' }, expiry: { gte: new Date(Date.now() - 86_400_000) } },
      orderBy: { expiry: 'asc' },
      select: { id: true, exchange: true, token: true },
    });
  }

  /** Newest `take` rows of one timeframe (index instrumentId+timeframe+timestamp), oldest first. Timestamps are UTC without zone. */
  private async bars(instrumentId: string, timeframe: '1m' | '15m' | '1d', take: number): Promise<Bar[]> {
    const rows = await this.prisma.candle.findMany({
      where: { instrumentId, timeframe },
      select: { timestamp: true, open: true, high: true, low: true, close: true },
      orderBy: { timestamp: 'desc' },
      take,
    });
    return rows.reverse().map((r) => ({ ts: r.timestamp.getTime(), open: r.open, high: r.high, low: r.low, close: r.close }));
  }

  /**
   * The hub's tick-built 1m bars (candles_1m), newest `take` SESSION minutes, oldest first. Empty on failure. Filtered in
   * SQL (market-hub session-sql) so the LIMIT covers ~5 NSE sessions, not ~170 off-session rows a day of flat copies.
   */
  private async hubBars(inst: Inst, take: number): Promise<Bar[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ ts: Date; open: number; high: number; low: number; close: number }>>`
        SELECT ts, open, high, low, close FROM "candles_1m"
        WHERE exchange = ${inst.exchange} AND token = ${inst.token} AND ts >= ${new Date(Date.now() - 10 * 86_400_000)}${sessionMinuteFilter(inst.exchange)}
        ORDER BY ts DESC LIMIT ${take}`;
      return rows.reverse().map((r) => ({ ts: new Date(r.ts).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
    } catch {
      return [];
    }
  }

  /**
   * 15m bars rolled up from the hub's candles_1m (2026-11-25): the `candles` table's 15m rows stopped months ago for
   * many names (NATURALGAS: newest 15m bar 21 Aug while trading 24 Nov), so the judges were told "15m stale" in live
   * MCX hours. Session minutes only, bucketed on 15-minute epoch boundaries (IST 09:00 / 09:15 are multiples of 15 min
   * from the UTC epoch because +5:30 is), OHLC = first open / max high / min low / last close, last
   * BROKER_FETCH['15m'].days days; newest `take` buckets, oldest first. Empty on failure.
   */
  private async hubFifteen(inst: Inst, take: number): Promise<Bar[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ bucket_s: bigint | number; open: number; high: number; low: number; close: number }>>`
        SELECT (floor(extract(epoch FROM ts) / 900) * 900)::bigint AS bucket_s,
               (array_agg(open ORDER BY ts ASC))[1] AS open, max(high) AS high, min(low) AS low,
               (array_agg(close ORDER BY ts DESC))[1] AS close
        FROM "candles_1m"
        WHERE exchange = ${inst.exchange} AND token = ${inst.token} AND ts >= ${new Date(Date.now() - BROKER_FETCH['15m'].days * 86_400_000)}${sessionMinuteFilter(inst.exchange)}
        GROUP BY 1 ORDER BY 1 DESC LIMIT ${take}`;
      return rows.reverse().map((r) => ({ ts: Number(r.bucket_s) * 1000, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
    } catch {
      return [];
    }
  }

  /**
   * Daily bars rolled up from the hub's candles_1m, one per IST session date, stamped at that date's IST midnight (UTC
   * ms) — the stamp staleReason('1d') and withTodayDaily expect. Session minutes only; last BROKER_FETCH['1d'].days days
   * (the hub keeps ~180); today's bar is the forming one. Newest `take`, oldest first. Empty on failure.
   */
  private async hubDaily(inst: Inst, take: number): Promise<Bar[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ ist_date: string; open: number; high: number; low: number; close: number }>>`
        SELECT to_char((ts AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS ist_date,
               (array_agg(open ORDER BY ts ASC))[1] AS open, max(high) AS high, min(low) AS low,
               (array_agg(close ORDER BY ts DESC))[1] AS close
        FROM "candles_1m"
        WHERE exchange = ${inst.exchange} AND token = ${inst.token} AND ts >= ${new Date(Date.now() - BROKER_FETCH['1d'].days * 86_400_000)}${sessionMinuteFilter(inst.exchange)}
        GROUP BY 1 ORDER BY 1 DESC LIMIT ${take}`;
      return rows
        .reverse()
        .map((r) => ({ ts: Date.parse(`${r.ist_date}T00:00:00+05:30`), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }))
        .filter((b) => Number.isFinite(b.ts));
    } catch {
      return [];
    }
  }
}

/** The view's own minimum for EMA80 timeframes: a roll-up this long is as usable as any table series. */
const MIN_ROLLUP_BARS = 100;
/** The table is "stale" against the hub when the hub's newest bar is more than this much newer. */
const TABLE_STALE_GAP_MS = 3 * 86_400_000;

/**
 * Of the `candles`-table series and the hub roll-up. The hub wins when (a) the table is empty, (b) the table is more
 * than 3 days behind the hub, whatever the hub's length (NATURALGAS 2026-11-25: table ends in August, hub has 56 15m
 * buckets / 4 days), or (c) the hub ends newer AND has >= min(table.length, 100) bars. Else the table: the hub daily
 * always ends on today's forming bar, and a stock watched for a few days must not swap 250 fresh daily bars for 3
 * (withTodayDaily appends today's bar from 15m anyway). Same last bar: the longer series (tie again: the table).
 */
function fresher(table: Bar[], hub: Bar[]): Bar[] {
  if (hub.length === 0) return table;
  if (table.length === 0) return hub;
  const t = table[table.length - 1].ts;
  const h = hub[hub.length - 1].ts;
  if (h === t) return hub.length > table.length ? hub : table;
  if (h - t > TABLE_STALE_GAP_MS) return hub;
  if (h > t && hub.length >= Math.min(table.length, MIN_ROLLUP_BARS)) return hub;
  return table;
}
