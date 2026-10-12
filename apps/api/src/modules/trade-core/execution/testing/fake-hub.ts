import type { HubPriceSource, HubPrices } from '../../../market-hub/hub-prices';
import { refKey, type InstrumentRef, type Price, type PriceResult, type Priority } from '../../../market-hub/hub.types';

/** A HubPrices for matcher tests: records watches, answers price() from setFresh, delivers push() to onPrice listeners. */
export class FakeHub implements HubPrices {
  readonly watches: Array<{ key: string; priority: Priority; owner: string }> = [];
  readonly unwatches: Array<{ key: string; owner: string }> = [];
  private readonly listeners = new Set<(p: Price) => void>();
  private readonly book = new Map<string, PriceResult>();

  price(ref: InstrumentRef, _opts: { maxAgeMs: number }): PriceResult {
    return this.book.get(refKey(ref)) ?? { kind: 'unavailable', reason: 'never-priced' };
  }

  prices(refs: readonly InstrumentRef[], opts: { maxAgeMs: number }): Map<string, PriceResult> {
    return new Map(refs.map((r) => [refKey(r), this.price(r, opts)] as const));
  }

  async watch(refs: readonly InstrumentRef[], priority: Priority, owner: string): Promise<void> {
    for (const r of refs) this.watches.push({ key: refKey(r), priority, owner });
  }

  async unwatch(refs: readonly InstrumentRef[], owner: string): Promise<void> {
    for (const r of refs) this.unwatches.push({ key: refKey(r), owner });
  }

  onPrice(fn: (p: Price) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  /** What price() answers from now on (the sweep's view). */
  setFresh(p: Price): void {
    this.book.set(refKey(p.ref), { kind: 'fresh', price: p });
  }

  /** A push, as the hub's onPrice delivers it. */
  push(p: Price): void {
    for (const fn of [...this.listeners]) fn(p);
  }
}

/** hubFor answers the listed users only (today the real hub serves only the owner). */
export function fakeHubSource(hubs: Readonly<Record<string, HubPrices>>): HubPriceSource {
  return { hubFor: (userId) => (userId !== null && hubs[userId]) || null, record: () => undefined };
}

/** What lookupHubPrices(moduleRef) reads: ModuleRef.get(HUB_PRICE_SOURCE, { strict: false }). */
export function fakeModuleRef(source: HubPriceSource | null): { get: () => HubPriceSource } {
  return {
    get: () => {
      if (!source) throw new Error('no market hub in this container');
      return source;
    },
  };
}
