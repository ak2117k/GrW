import { N15_LOOKBACK_DAYS, n15FromBars } from '../../exit-discipline/cut-loss-yardstick';
import type { ChartBar } from '../../exit-discipline/chart-read';
import type { CandleRepo } from '../../market-hub/candles/candle-repository';
import type { InstrumentRef } from '../../market-hub/hub.types';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';

export const CHART_CONFIRM_READER = Symbol('CHART_CONFIRM_READER');

/** What the reader needs to find a position's underlying (ExitNoiseRepository has all four). */
export interface UnderlyingLookup {
  tracker(id: string): Promise<{ symbol: string; exchange: string; token: string } | null>;
  contract(exchange: string, token: string, symbol: string): Promise<{ name: string | null } | null>;
  nearestFuture(name: string, from: Date): Promise<{ exchange: string; token: string; symbol: string } | null>;
  cashRef(name: string): Promise<{ exchange: string; token: string; symbol: string } | null>;
}

export type ChartData = { ref: { exchange: string; token: string; symbol: string }; bars5: ChartBar[]; bars15: ChartBar[]; n15: number | null };

const CASH = new Set(['NSE', 'BSE']);
const CACHE_MS = 30_000;
const IST_MS = 5.5 * 3_600_000;

/**
 * The underlying's closed 5- and 15-minute bars (candles_1m rolled up in SQL, a DATABASE read, never the broker)
 * and its N15, for the loss-side chart confirmation (exit-discipline/chart-read.ts). Never throws: null when the
 * underlying cannot be resolved or read — the gate then lets the exit stand (today's behaviour).
 */
export class ChartConfirmReader {
  private readonly cache = new Map<string, { at: number; v: ChartData | null }>();

  constructor(private readonly candles: Pick<CandleRepo, 'readBucketed'>, private readonly lookup: UnderlyingLookup) {}

  async read(trackerId: string, now: Date): Promise<ChartData | null> {
    const hit = this.cache.get(trackerId);
    if (hit && now.getTime() - hit.at < CACHE_MS) return hit.v;
    let v: ChartData | null = null;
    try {
      const ref = await this.underlying(trackerId, now);
      if (ref) {
        const from = now.getTime() - N15_LOOKBACK_DAYS * 86_400_000;
        const r = { ...ref, exchange: ref.exchange.toUpperCase() } as InstrumentRef;
        const [b5, b15] = await Promise.all([
          this.candles.readBucketed(r, 5, 555, from, now.getTime()),
          this.candles.readBucketed(r, 15, 555, from, now.getTime()),
        ]);
        const closed = (step: number) => (b: { ts: number }) => b.ts + step * 60_000 <= now.getTime();
        const map = (b: { ts: number; open: number; high: number; low: number; close: number; volume?: number | bigint | null }): ChartBar =>
          ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume == null ? null : Number(b.volume) });
        const bars5 = b5.filter(closed(5)).map(map).sort((a, b) => a.ts - b.ts);
        const bars15 = b15.filter(closed(15)).map(map).sort((a, b) => a.ts - b.ts);
        const n15 = n15FromBars(bars15, r.exchange, now.getTime())?.n ?? null;
        v = { ref, bars5, bars15, n15 };
      }
    } catch {
      v = null;
    }
    this.cache.set(trackerId, { at: now.getTime(), v });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
    return v;
  }

  /** The index, an MCX contract's nearest future, or a stock's cash line (same mapping as exit-noise). */
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
