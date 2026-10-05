import { DEFAULT_RATES, Governor, type GovernorMetrics } from './governor';
import type { HubBroker } from './hub-broker';
import { refKey, type InstrumentRef, type Price, type PriceResult, type Priority } from './hub.types';
import { LiveFeed } from './live-feed';
import { PriceBook } from './price-book';
import { QuoteBatcher } from './quote-batcher';
import { QuotePoller } from './quote-poller';
import type { SessionClock } from './session-clock';
import { WatchRegistry } from './watch-registry';
import { AngelThrottleError } from '../market-data/services/angel-throttle';

export interface HubEngineDeps {
  broker: HubBroker;
  clock: SessionClock;
  cap: number;
  /** Market-context instruments watched at priority 2 for as long as the hub runs. */
  defaults: readonly InstrumentRef[];
}

export interface HubStatus {
  socketUp: boolean;
  watched: number;
  slots: { live: number; cap: number; demotionsTotal: number; criticalOverflow: number };
  prices: {
    fresh: number;
    stale: number;
    marketClosed: number;
    unavailable: number;
    oldestP0AgeMs: number | null;
    unpricedP0: number;
  };
  governor: GovernorMetrics;
  calendar: { missingYear: number | null };
}

const POSITIONS = 'hub:positions';
const CONTEXT = 'hub:context';
const STATUS_MAX_AGE_MS = 5000;

/** Wires the hub's parts. No NestJS, no config — testable with a FakeBroker. */
export class HubEngine {
  readonly registry = new WatchRegistry();
  readonly book = new PriceBook();
  readonly governor: Governor;
  readonly feed: LiveFeed;
  private readonly poller: QuotePoller;
  private positions = new Map<string, InstrumentRef>();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: HubEngineDeps) {
    this.governor = new Governor({
      ratesPerSec: DEFAULT_RATES,
      interactiveDeadlineMs: 5000,
      backgroundTrickleMs: 5000,
      maxBackoffMs: 30_000,
      isMarketHours: () => ['NSE', 'MCX'].some((ex) => d.clock.isOpen(ex)),
      isThrottle: (e) => e instanceof AngelThrottleError,
    });
    this.feed = new LiveFeed({ broker: d.broker, registry: this.registry, book: this.book, cap: d.cap });
    const batcher = new QuoteBatcher(this.governor, (refs) => d.broker.quotes(refs));
    this.poller = new QuotePoller({
      feed: this.feed,
      book: this.book,
      batcher,
      clock: d.clock,
      nearLiveTargetMs: 5000,
      criticalTargetMs: 2000,
    });
  }

  async start(): Promise<void> {
    await this.d.broker.connect();
    const now = Date.now();
    for (const ref of this.d.defaults) this.registry.watch(ref, 2, CONTEXT, now);
    await this.feed.reconcile();
    this.poller.start();
    this.expiryTimer = setInterval(() => {
      if (this.registry.expire(Date.now())) void this.feed.reconcile();
    }, 30_000);
    this.expiryTimer.unref?.();
  }

  stop(): void {
    this.poller.stop();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    this.governor.dispose();
  }

  async watch(ref: InstrumentRef, priority: Priority, owner: string, ttlMs?: number): Promise<void> {
    this.registry.watch(ref, priority, owner, Date.now(), ttlMs);
    await this.feed.reconcile();
  }

  async unwatch(ref: InstrumentRef, owner: string): Promise<void> {
    this.registry.unwatch(ref, owner);
    await this.feed.reconcile();
  }

  /** Replace the set of open-position instruments (priority 0). */
  async setPositions(refs: readonly InstrumentRef[]): Promise<void> {
    const next = new Map(refs.map((r) => [refKey(r), r] as const));
    const now = Date.now();
    for (const [k, r] of this.positions) if (!next.has(k)) this.registry.unwatch(r, POSITIONS);
    for (const r of next.values()) this.registry.watch(r, 0, POSITIONS, now);
    this.positions = next;
    await this.feed.reconcile();
  }

  price(ref: InstrumentRef, opts: { maxAgeMs: number }): PriceResult {
    const now = Date.now();
    return this.book.get(ref, {
      maxAgeMs: opts.maxAgeMs,
      now,
      isOpen: (ex) => this.d.clock.isOpen(ex, new Date(now)),
      watched: (key) => this.registry.has(key),
    });
  }

  prices(refs: readonly InstrumentRef[], opts: { maxAgeMs: number }): Map<string, PriceResult> {
    return new Map(refs.map((r) => [refKey(r), this.price(r, opts)] as const));
  }

  onPrice(fn: (p: Price) => void): () => void {
    return this.feed.onPrice(fn);
  }

  status(): HubStatus {
    const now = Date.now();
    const counts = { fresh: 0, stale: 0, marketClosed: 0, unavailable: 0 };
    let oldestP0AgeMs: number | null = null;
    let unpricedP0 = 0;
    for (const e of this.registry.entries()) {
      const r = this.price(e.ref, { maxAgeMs: STATUS_MAX_AGE_MS });
      if (r.kind === 'fresh') counts.fresh++;
      else if (r.kind === 'stale') counts.stale++;
      else if (r.kind === 'market-closed') counts.marketClosed++;
      else counts.unavailable++;
      if (e.priority === 0) {
        const age = this.book.ageMs(refKey(e.ref), now);
        if (age === undefined) unpricedP0++;
        else if (oldestP0AgeMs === null || age > oldestP0AgeMs) oldestP0AgeMs = age;
      }
    }
    const m = this.feed.metrics();
    return {
      socketUp: m.socketUp,
      watched: this.registry.size(),
      slots: { live: m.live, cap: m.cap, demotionsTotal: m.demotionsTotal, criticalOverflow: m.criticalOverflow },
      prices: { ...counts, oldestP0AgeMs, unpricedP0 },
      governor: this.governor.metrics(now),
      calendar: { missingYear: this.d.clock.calendarGap(new Date(now)) },
    };
  }
}
