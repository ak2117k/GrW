import { Injectable } from '@nestjs/common';
import { NOISE_LOOKBACK_MIN } from '../../exit-discipline/config';
import type { MinuteBar } from '../../exit-discipline/types';
import { N15_LOOKBACK_DAYS, n15FromBars, type N15Reading } from '../../exit-discipline/cut-loss-yardstick';
import type { CandleRepo } from '../../market-hub/candles/candle-repository';
import type { InstrumentRef } from '../../market-hub/hub.types';

type Ref = { exchange: string; token: string; symbol: string };
const CACHE_MS = 20_000;
const CACHE_MAX = 500;
const N15_CACHE_MS = 60_000;
/** How far before an anchor minute `closeAt` may reach for a bar (a quiet minute stores none). */
export const ANCHOR_WINDOW_MIN = 5;
const IST_OFFSET_MS = 5.5 * 3_600_000;
const istMidnightUtc = (now: Date) => {
  const ist = now.getTime() + IST_OFFSET_MS;
  return ist - (ist % 86_400_000) - IST_OFFSET_MS;
};

/**
 * Exit discipline §3: the hub's tick-built 1-minute bars, read from candles_1m.
 * A DATABASE read only — never a broker call (no getCandles, no fill). Never
 * throws: a failed read is an empty one, and the caller then states the noise
 * unit absent. Cached 20 s per EXCHANGE:token so a cycle over several positions
 * on one underlying reads it once.
 */
@Injectable()
export class MinuteBarsReader {
  private readonly cache = new Map<string, { at: number; bars: MinuteBar[] }>();
  private readonly n15Cache = new Map<string, { at: number; v: N15Reading | null }>();
  constructor(private readonly repo: Pick<CandleRepo, 'read'> & Partial<Pick<CandleRepo, 'readBucketed'>>) {}

  /**
   * CATASTROPHE FLOOR (HARD_LOSS_CEILING_BY_CLASS): the instrument's 15-minute noise unit — ATR14 of its
   * 15-minute session bars (exit-discipline/cut-loss-yardstick.ts `n15FromBars`) from candles_1m rolled up to
   * 15-minute buckets in SQL. The same read as sentinel-executor's N15Reader (kept here because trade-sentinel
   * must not import the executor). DB only, never a broker call. Never throws: a failed read is null. Cached
   * {@link N15_CACHE_MS} per EXCHANGE:token.
   */
  async n15(ref: Ref, now: Date): Promise<N15Reading | null> {
    const exchange = String(ref.exchange ?? '').toUpperCase();
    const key = `${exchange}:${ref.token}`;
    const hit = this.n15Cache.get(key);
    if (hit && now.getTime() - hit.at < N15_CACHE_MS) return hit.v;
    let v: N15Reading | null = null;
    try {
      if (this.repo.readBucketed) {
        const from = now.getTime() - N15_LOOKBACK_DAYS * 86_400_000;
        // Origin 09:15 IST: a multiple of 15 minutes, so the buckets are clock-aligned for MCX (09:00) too.
        const bars = await this.repo.readBucketed({ ...ref, exchange } as InstrumentRef, 15, 555, from, now.getTime());
        v = n15FromBars(bars.map((b) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close })), exchange, now.getTime());
      }
    } catch {
      v = null;
    }
    this.n15Cache.delete(key);
    this.n15Cache.set(key, { at: now.getTime(), v });
    if (this.n15Cache.size > CACHE_MAX) this.n15Cache.delete(this.n15Cache.keys().next().value as string);
    return v;
  }

  async recent(ref: Ref, now: Date): Promise<MinuteBar[]> {
    const key = `${ref.exchange}:${ref.token}`;
    const hit = this.cache.get(key);
    if (hit && now.getTime() - hit.at < CACHE_MS) return hit.bars;
    const from = Math.max(now.getTime() - NOISE_LOOKBACK_MIN * 60_000, istMidnightUtc(now));
    let bars: MinuteBar[] = [];
    try {
      bars = (await this.repo.read('1m', ref as InstrumentRef, from, now.getTime())).map((c) => ({
        ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close,
      }));
    } catch {
      bars = [];
    }
    this.cache.delete(key);
    this.cache.set(key, { at: now.getTime(), bars });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    return bars;
  }

  /**
   * The close of the last stored 1-minute bar starting in the {@link ANCHOR_WINDOW_MIN} minutes up
   * to and including `at`'s minute — the equity block's "NIFTY at entry". Null when none is stored
   * or the read failed. Uncached here: the caller keeps one answer per position. DB only.
   */
  async closeAt(ref: Ref, at: Date): Promise<number | null> {
    const minute = Math.floor(at.getTime() / 60_000) * 60_000;
    try {
      const bars = await this.repo.read('1m', ref as InstrumentRef, minute - (ANCHOR_WINDOW_MIN - 1) * 60_000, minute + 60_000);
      const c = bars.length > 0 ? bars[bars.length - 1].close : null;
      return typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : null;
    } catch {
      return null;
    }
  }
}
