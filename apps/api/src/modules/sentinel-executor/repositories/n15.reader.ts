// apps/api/src/modules/sentinel-executor/repositories/n15.reader.ts
import { N15_LOOKBACK_DAYS, n15FromBars, type N15Reading } from '../../exit-discipline/cut-loss-yardstick';
import type { CandleRepo } from '../../market-hub/candles/candle-repository';
import type { InstrumentRef } from '../../market-hub/hub.types';

export const TRIGGER_N15_READER = Symbol('TRIGGER_N15_READER');

const CACHE_MS = 60_000;
const CACHE_MAX = 200;

/**
 * The underlying's 15-minute noise unit (exit-discipline/cut-loss-yardstick.ts `n15FromBars`) from the hub's
 * candles_1m rolled up to 15-minute buckets in SQL (date_bin). A DATABASE read only — never a broker call.
 * Never throws: a failed read is null (the CUT_LOSS rule then falls back to K × N1, today's rule). Cached
 * 60 s per EXCHANGE:token.
 */
export class N15Reader {
  private readonly cache = new Map<string, { at: number; v: N15Reading | null }>();
  constructor(private readonly repo: Pick<CandleRepo, 'readBucketed'>) {}

  async n15(ref: { exchange: string; token: string; symbol: string }, now: Date): Promise<N15Reading | null> {
    const exchange = String(ref.exchange ?? '').toUpperCase();
    const key = `${exchange}:${ref.token}`;
    const hit = this.cache.get(key);
    if (hit && now.getTime() - hit.at < CACHE_MS) return hit.v;
    let v: N15Reading | null = null;
    try {
      const from = now.getTime() - N15_LOOKBACK_DAYS * 86_400_000;
      // Origin 09:15 IST: a multiple of 15 minutes, so the buckets are clock-aligned for MCX (09:00) too.
      const bars = await this.repo.readBucketed({ ...ref, exchange } as InstrumentRef, 15, 555, from, now.getTime());
      v = n15FromBars(bars.map((b) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close })), exchange, now.getTime());
    } catch {
      v = null;
    }
    this.cache.delete(key);
    this.cache.set(key, { at: now.getTime(), v });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    return v;
  }
}
