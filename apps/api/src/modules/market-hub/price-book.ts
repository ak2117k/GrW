import { refKey, type InstrumentRef, type Price, type PriceResult } from './hub.types';

export interface PriceQuery {
  maxAgeMs: number;
  now: number;
  isOpen: (exchange: string) => boolean;
  watched: (key: string) => boolean;
}

/**
 * The hub's one price cache. It never hands out an old price as if it were
 * current: every answer is fresh, market-closed, stale-with-age, or
 * unavailable-with-reason. Bounded (insertion-ordered Map as an LRU-by-write).
 */
export class PriceBook {
  private readonly prices = new Map<string, Price>();
  private readonly failures = new Map<string, 'throttled' | 'no-session'>();

  constructor(private readonly maxEntries = 5000) {}

  set(price: Price): void {
    const key = refKey(price.ref);
    this.prices.delete(key);
    this.prices.set(key, price);
    this.failures.delete(key);
    while (this.prices.size > this.maxEntries) {
      const oldest = this.prices.keys().next().value as string;
      this.prices.delete(oldest);
    }
  }

  markFailure(key: string, reason: 'throttled' | 'no-session'): void {
    this.failures.set(key, reason);
    if (this.failures.size > this.maxEntries) {
      this.failures.delete(this.failures.keys().next().value as string);
    }
  }

  ageMs(key: string, now: number): number | undefined {
    const p = this.prices.get(key);
    return p ? now - p.at : undefined;
  }

  size(): number {
    return this.prices.size;
  }

  get(ref: InstrumentRef, q: PriceQuery): PriceResult {
    const key = refKey(ref);
    const price = this.prices.get(key);
    if (!price) {
      const failure = this.failures.get(key);
      if (failure) return { kind: 'unavailable', reason: failure };
      return { kind: 'unavailable', reason: q.watched(key) ? 'never-priced' : 'not-watched' };
    }
    if (!q.isOpen(ref.exchange)) return { kind: 'market-closed', price };
    const ageMs = q.now - price.at;
    return ageMs <= q.maxAgeMs ? { kind: 'fresh', price } : { kind: 'stale', price, ageMs };
  }
}
