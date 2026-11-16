import { Injectable, Logger } from '@nestjs/common';
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

type Inst = { id: string; exchange: string; token: string };

/**
 * Loads an UNDERLYING's 1m / 15m / 1d bars from the `candles` table and returns the pure
 * {@link multiTimeframeView} read. Resolution, as the overnight scorecard resolves underlyings:
 *   - an index (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) → its index token row (INDEX_UNDERLYINGS),
 *   - exchange MCX → the nearest live future of that name (symbol ending FUT),
 *   - else the NSE cash line (`<SYM>-EQ`, then `<SYM>`), falling back to an MCX future when no cash line exists.
 * Database reads only (never the broker). Never throws: null + a warn on failure or no instrument.
 * Cached 60 s per symbol+exchange (concurrent callers share one load).
 */
@Injectable()
export class MultiTimeframeReaderService {
  private readonly logger = new Logger(MultiTimeframeReaderService.name);
  private readonly cache = new Map<string, { at: number; value: Promise<MultiTimeframeView | null> }>();

  constructor(private readonly prisma: PrismaService) {}

  read(symbol: string, exchange: string): Promise<MultiTimeframeView | null> {
    const sym = String(symbol ?? '').trim().toUpperCase();
    const ex = String(exchange ?? '').trim().toUpperCase();
    if (!sym) return Promise.resolve(null);
    const key = `${sym}:${ex}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const value = this.load(sym, ex);
    this.cache.delete(key);
    this.cache.set(key, { at: now, value });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  private async load(sym: string, ex: string): Promise<MultiTimeframeView | null> {
    try {
      const inst = await this.resolve(sym, ex);
      if (!inst) {
        this.logger.warn(`multi-timeframe: no instrument for ${sym} (${ex || '?'})`);
        return null;
      }
      const isMcx = inst.exchange === 'MCX';
      const take = isMcx ? TAKE.MCX : TAKE.NSE;
      const [m1, m15, d1] = await Promise.all([
        this.bars(inst.id, '1m', take['1m']),
        this.bars(inst.id, '15m', take['15m']),
        this.bars(inst.id, '1d', TAKE['1d']),
      ]);
      const oneMin = m1.length >= MIN_1M_ROWS ? m1 : await this.hubBars(inst, take['1m']).then((h) => (h.length > m1.length ? h : m1));
      return multiTimeframeView({ exchange: inst.exchange, '1m': oneMin, '15m': m15, '1d': d1 });
    } catch (e) {
      this.logger.warn(`multi-timeframe: read failed for ${sym} (${ex || '?'}): ${(e as Error)?.message ?? e}`);
      return null;
    }
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
