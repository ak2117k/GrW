import type { TickData } from '../../common/interfaces/broker-adapter.interface';
import type { HubBroker } from './hub-broker';
import { refKey, type InstrumentRef, type Price } from './hub.types';
import type { PriceBook } from './price-book';
import { allocateSlots, type Allocation } from './slot-allocator';
import type { WatchRegistry } from './watch-registry';

export interface LiveFeedDeps {
  broker: HubBroker;
  registry: WatchRegistry;
  book: PriceBook;
  cap: number;
}

const EMPTY: Allocation = { live: [], nearLive: [], criticalOverflow: [], demoted: 0 };

/** Turns the priority allocation into WebSocket subscriptions and ticks into prices. */
export class LiveFeed {
  private live = new Map<string, InstrumentRef>();
  private current: Allocation = EMPTY;
  private socketUp = false;
  private demotionsTotal = 0;
  private readonly priceListeners = new Set<(p: Price) => void>();

  constructor(private readonly d: LiveFeedDeps) {
    d.broker.onTick((t) => this.onTick(t));
    d.broker.onState((s) => {
      this.socketUp = s === 'live';
    });
  }

  get wsHealthy(): boolean {
    return this.socketUp;
  }

  allocation(): Allocation {
    return this.current;
  }

  onPrice(fn: (p: Price) => void): () => void {
    this.priceListeners.add(fn);
    return () => this.priceListeners.delete(fn);
  }

  async reconcile(): Promise<Allocation> {
    const alloc = allocateSlots(this.d.registry.entries(), this.d.cap);
    const want = new Map(alloc.live.map((e) => [refKey(e.ref), e.ref] as const));
    const add = [...want].filter(([k]) => !this.live.has(k)).map(([, r]) => r);
    const remove = [...this.live].filter(([k]) => !want.has(k)).map(([k, r]) => [k, r] as const);
    const stillWatched = new Set(alloc.nearLive.map((e) => refKey(e.ref)));
    this.demotionsTotal += remove.filter(([k]) => stillWatched.has(k)).length;
    if (remove.length > 0) await this.d.broker.unsubscribe(remove.map(([, r]) => r));
    if (add.length > 0) await this.d.broker.subscribe(add);
    this.live = want;
    this.current = alloc;
    return alloc;
  }

  metrics() {
    return {
      live: this.live.size,
      cap: this.d.cap,
      demotionsTotal: this.demotionsTotal,
      criticalOverflow: this.current.criticalOverflow.length,
      socketUp: this.socketUp,
    };
  }

  private onTick(t: TickData): void {
    const ref = t.exchange ? this.live.get(`${t.exchange}:${t.token}`) : this.byToken(t.token);
    if (!ref) return;
    const price: Price = {
      ref,
      ltp: t.ltp,
      at: Date.now(), // receipt time: the price is confirmed current NOW
      source: 'ws',
      volume: t.volume,
      oi: t.oi,
    };
    this.d.book.set(price);
    for (const fn of this.priceListeners) fn(price);
  }

  /** Fallback when a tick lacks its exchange: accept only an unambiguous token. */
  private byToken(token: string): InstrumentRef | undefined {
    const matches = [...this.live.values()].filter((r) => r.token === token);
    return matches.length === 1 ? matches[0] : undefined;
  }
}
