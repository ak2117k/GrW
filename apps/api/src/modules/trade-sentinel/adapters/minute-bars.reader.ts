import { Injectable } from '@nestjs/common';
import { NOISE_LOOKBACK_MIN } from '../../exit-discipline/config';
import type { MinuteBar } from '../../exit-discipline/types';
import type { CandleRepo } from '../../market-hub/candles/candle-repository';
import type { InstrumentRef } from '../../market-hub/hub.types';

type Ref = { exchange: string; token: string; symbol: string };
const CACHE_MS = 20_000;
const CACHE_MAX = 500;
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
  constructor(private readonly repo: Pick<CandleRepo, 'read'>) {}

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
}
