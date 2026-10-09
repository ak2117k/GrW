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
  /** The run in flight, as a promise that never rejects; null when idle. */
  private inFlight: Promise<void> | null = null;
  /** The one run queued behind `inFlight`, shared by every caller that arrived during it. */
  private trailing: Promise<Allocation> | null = null;

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

  /**
   * Single-flight and coalescing. Two overlapping runs would plan their add and
   * remove sets from the same `live` map, and whichever settled last would
   * overwrite `live` (and `current`) with its own plan: a run that started
   * before a registry change could land after a newer run and leave `live`
   * stale, and onTick drops ticks for any subscribed instrument `live` does
   * not list. (Pin/unpin ref counts are not the risk: pins are idempotent per
   * key.) So a call made while a run is in flight waits for a
   * trailing run, which starts after the current run settles and so sees every
   * registry change made meanwhile. All callers waiting together share that one
   * trailing run. A failed run rejects only its own callers; the next run still
   * happens.
   */
  reconcile(): Promise<Allocation> {
    if (!this.inFlight) return this.launch();
    if (!this.trailing) {
      this.trailing = this.inFlight.then(() => {
        this.trailing = null;
        return this.launch();
      });
    }
    return this.trailing;
  }

  /** Start one run now and mark it in flight until it settles (resolved or rejected). */
  private launch(): Promise<Allocation> {
    const run = this.reconcileOnce();
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight = settled;
    void settled.then(() => {
      if (this.inFlight === settled) this.inFlight = null;
    });
    return run;
  }

  /**
   * One plan-and-apply pass. If subscribe throws, `live` is unchanged, so the
   * next run retries the same subscriptions.
   */
  private async reconcileOnce(): Promise<Allocation> {
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
