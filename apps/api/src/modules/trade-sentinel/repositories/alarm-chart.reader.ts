import { N15_LOOKBACK_DAYS, n15FromBars } from '../../exit-discipline/cut-loss-yardstick';
import type { ChartBar } from '../../exit-discipline/chart-read';
import { sessionOnlyBars, venueSession } from '../../exit-discipline/session-bars';
import { PrismaCandleRepo, type CandleRepo } from '../../market-hub/candles/candle-repository';
import type { InstrumentRef } from '../../market-hub/hub.types';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { ExitNoiseRepository } from '../../exit-noise/exit-noise.repository';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { AlarmChartData, AlarmChartReader } from '../services/alarm-chart';

/**
 * The alarm look's chart read (services/alarm-chart.ts, ALARM_CHART_READER): the position's UNDERLYING closed 5- and
 * 15-minute SESSION bars (candles_1m rolled up in SQL — a database read, never the broker) and its N15.
 *
 * The same read the executor's loss-side chart confirmation makes (sentinel-executor/repositories/chart-confirm.reader.ts),
 * COPIED rather than imported: plan R14 / sentinel-executor.structure.spec.ts — no trade-sentinel file imports the
 * executor. Keep the two in step (underlying mapping, session buckets, N15).
 */

/** What the reader needs to find a position's underlying (ExitNoiseRepository has all four). */
export interface AlarmUnderlyingLookup {
  tracker(id: string): Promise<{ symbol: string; exchange: string; token: string } | null>;
  contract(exchange: string, token: string, symbol: string): Promise<{ name: string | null } | null>;
  nearestFuture(name: string, from: Date): Promise<{ exchange: string; token: string; symbol: string } | null>;
  cashRef(name: string): Promise<{ exchange: string; token: string; symbol: string } | null>;
}

const CASH = new Set(['NSE', 'BSE']);
/** Short: the alarm look wants a FRESH read; this only absorbs two looks inside one pass. */
const CACHE_MS = 10_000;
const IST_MS = 5.5 * 3_600_000;

export class AlarmChartRepository implements AlarmChartReader {
  private readonly cache = new Map<string, { at: number; v: AlarmChartData | null }>();

  constructor(private readonly candles: Pick<CandleRepo, 'readBucketed'>, private readonly lookup: AlarmUnderlyingLookup) {}

  /** Null when the underlying cannot be resolved. A failed read REJECTS (the cycle words it as unavailable). */
  async read(trackerId: string, now: Date): Promise<AlarmChartData | null> {
    const hit = this.cache.get(trackerId);
    if (hit && now.getTime() - hit.at >= 0 && now.getTime() - hit.at < CACHE_MS) return hit.v;
    const ref = await this.underlying(trackerId, now);
    let v: AlarmChartData | null = null;
    if (ref) {
      const from = now.getTime() - N15_LOOKBACK_DAYS * 86_400_000;
      const r = { ...ref, exchange: ref.exchange.toUpperCase() } as InstrumentRef;
      // Buckets aligned to the venue's session open (NSE/BSE 09:15, MCX 09:00; 555 for an unknown venue).
      const origin = venueSession(r.exchange)?.fromMin ?? 555;
      const [b5, b15] = await Promise.all([
        this.candles.readBucketed(r, 5, origin, from, now.getTime()),
        this.candles.readBucketed(r, 15, origin, from, now.getTime()),
      ]);
      const closed = (step: number) => (b: { ts: number }) => b.ts + step * 60_000 <= now.getTime();
      const map = (b: { ts: number; open: number; high: number; low: number; close: number; volume?: number | bigint | null }): ChartBar =>
        ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume == null ? null : Number(b.volume) });
      // Session buckets only (exit-discipline/session-bars): the pre-open auction and flat off-session buckets excluded.
      const bars5 = sessionOnlyBars(b5.filter(closed(5)), r.exchange, 5).map(map).sort((a, b) => a.ts - b.ts);
      const bars15 = sessionOnlyBars(b15.filter(closed(15)), r.exchange, 15).map(map).sort((a, b) => a.ts - b.ts);
      const n15 = n15FromBars(bars15, r.exchange, now.getTime())?.n ?? null;
      v = { ref, bars5, bars15, n15 };
    }
    this.cache.set(trackerId, { at: now.getTime(), v });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
    return v;
  }

  /** The index, an MCX contract's nearest future, or a stock's cash line (the executor's / exit-noise's mapping). */
  private async underlying(trackerId: string, now: Date) {
    const t = await this.lookup.tracker(trackerId);
    if (!t) return null;
    const exchange = t.exchange.toUpperCase();
    if (CASH.has(exchange)) return { exchange, token: t.token, symbol: t.symbol };
    const name = String((await this.lookup.contract(exchange, t.token, t.symbol))?.name ?? '').toUpperCase();
    if (!name) return null;
    const index = INDEX_UNDERLYINGS[name];
    if (index) return { exchange: index.exchange, token: index.token, symbol: index.symbol };
    if (exchange === 'MCX') {
      const istToday = new Date(Math.floor((now.getTime() + IST_MS) / 86_400_000) * 86_400_000 - IST_MS);
      return this.lookup.nearestFuture(name, istToday);
    }
    return this.lookup.cashRef(name);
  }
}

/** Task 7 binds it: `{ provide: ALARM_CHART_READER, useFactory: alarmChartReaderFor, inject: [PrismaService] }`. */
export function alarmChartReaderFor(prisma: PrismaService): AlarmChartReader {
  return new AlarmChartRepository(new PrismaCandleRepo(prisma as never), new ExitNoiseRepository(prisma));
}
