import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
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
 * Lookbacks give EMA80 room: 1m 6 days, 15m 45 days, 1d 400 days.
 */
export const BROKER_FETCH = {
  '1m': { days: 6, refreshMs: 2 * 60_000 },
  '15m': { days: 45, refreshMs: 5 * 60_000 },
  '1d': { days: 400, refreshMs: 6 * 3_600_000 },
} as const;
type BrokerTf = keyof typeof BROKER_FETCH;

type Inst = { id: string; exchange: string; token: string };

/**
 * The broker-history port (bound in TradeSentinelModule to UserFeedManager). A type-only seam: the
 * sentinel's services must never import anything that can reach order placement (structural spec).
 */
export interface BarHistory {
  fetchCandles(userId: string, token: string, exchange: string, timeframe: string, from: Date, to: Date): Promise<unknown>;
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
 * hub's candles_1m). Resolution, as the overnight scorecard resolves underlyings:
 *   - an index (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) → its index token row (INDEX_UNDERLYINGS),
 *   - exchange MCX → the nearest live future of that name (symbol ending FUT),
 *   - else the NSE cash line (`<SYM>-EQ`, then `<SYM>`), falling back to an MCX future when no cash line exists.
 * Never throws: null + a warn on failure or no instrument. The view is cached 60 s per symbol+exchange.
 */
@Injectable()
export class MultiTimeframeReaderService {
  private readonly logger = new Logger(MultiTimeframeReaderService.name);
  private readonly cache = new Map<string, { at: number; value: Promise<MultiTimeframeView | null> }>();
  private readonly brokerBars = new Map<string, { at: number; bars: Bar[] }>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(MTF_BAR_HISTORY) private readonly feeds?: BarHistory,
  ) {}

  read(symbol: string, exchange: string, userId?: string | null): Promise<MultiTimeframeView | null> {
    const sym = String(symbol ?? '').trim().toUpperCase();
    const ex = String(exchange ?? '').trim().toUpperCase();
    if (!sym) return Promise.resolve(null);
    const key = `${sym}:${ex}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const value = this.load(sym, ex, userId ?? null);
    this.cache.delete(key);
    this.cache.set(key, { at: now, value });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    return value;
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
      const m15 = b15 ?? (await this.bars(inst.id, '15m', take['15m']));
      const d1 = bd ?? (await this.bars(inst.id, '1d', TAKE['1d']));
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
      const rows = ((await this.feeds.fetchCandles(userId, inst.token, inst.exchange, tf, from, new Date(now))) ?? []) as Candle[];
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

  /** The hub's tick-built 1m bars (candles_1m), newest `take`, oldest first. Empty on failure. */
  private async hubBars(inst: Inst, take: number): Promise<Bar[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ ts: Date; open: number; high: number; low: number; close: number }>>`
        SELECT ts, open, high, low, close FROM "candles_1m"
        WHERE exchange = ${inst.exchange} AND token = ${inst.token} AND ts >= ${new Date(Date.now() - 10 * 86_400_000)}
        ORDER BY ts DESC LIMIT ${take}`;
      return rows.reverse().map((r) => ({ ts: new Date(r.ts).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
    } catch {
      return [];
    }
  }
}
