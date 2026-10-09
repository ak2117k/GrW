import { CandleBuilder, type ClosedBar } from './candles/candle-builder';
import type { CandleRepo } from './candles/candle-repository';
import { CandleStore, type FixupReport } from './candles/candle-store';
import type { CandlesResult, Timeframe } from './candles/candle.types';
import { istMidnight } from './candles/trading-calendar';
import { DEFAULT_RATES, Governor, type GovernorMetrics } from './governor';
import type { HubBroker } from './hub-broker';
import type { HubConsumer, HubOutcome } from './hub-prices';
import {
  LANE,
  refKey,
  type InstrumentRef,
  type Lane,
  type Price,
  type PriceResult,
  type Priority,
} from './hub.types';
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
  /** M2 CandleStore. Absent ⇒ no tick bars, no candle reads (M1 behaviour). */
  candles?: { repo: CandleRepo; interactiveCallBudget?: number };
  /** The HUB_PRICES_POSITIONS / HUB_PRICES_TRACKS switches, read at status time. Absent ⇒ both off. */
  consumerFlags?: () => ConsumerFlags;
}

/** The two consumer switches, so /healthz/detail tells "hub served 0" apart from "switch off". */
export interface ConsumerFlags {
  positions: boolean;
  tracks: boolean;
}

export interface CandleStatus {
  building: number;
  lateTicks: number;
  tickBarsWritten: number;
  tickBarsDropped: number;
  tickWriteFailures: number;
  lastTickWriteAt: number | null;
  reads: number;
  readP95Ms: number;
  dbReadP95Ms: number;
  deferredFills: number;
  fillErrors: number;
  lastError: string | null;
  lastFixup: FixupReport | null;
}

/** One consumer's outcomes since boot (spec §10: unpriced positions must be visible, never silent). */
export interface ConsumerCounters {
  hub: number;
  legacy: number;
  unpriced: number;
  lastHubAt: number | null;
  lastUnpricedAt: number | null;
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
  /** Last broker connect/subscribe failure; null once a reconcile succeeds. */
  lastError: string | null;
  /** M2 candle store; null when candles are not enabled. */
  candles: CandleStatus | null;
  /** M3: per consumer, how often the hub served, the legacy path served, or nothing did. */
  consumers: { positions: ConsumerCounters; tracks: ConsumerCounters; listenerErrors: number; flags: ConsumerFlags };
}

const POSITIONS = 'hub:positions';
const CONTEXT = 'hub:context';
const STATUS_MAX_AGE_MS = 5000;
const TICK_FLUSH_MS = 5000;
const MAX_PENDING_BARS = 20_000;
/** CandleBuilder's close grace (its default), named so stop() can close exactly the ended minutes. */
const TICK_GRACE_MS = 2000;

/** Wires the hub's parts. No NestJS, no config — testable with a FakeBroker. */
export class HubEngine {
  readonly registry = new WatchRegistry();
  readonly book = new PriceBook();
  readonly governor: Governor;
  readonly feed: LiveFeed;
  private readonly poller: QuotePoller;
  private positions = new Map<string, { ref: InstrumentRef; priority: Priority }>();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  private readonly builder: CandleBuilder | null;
  private readonly store: CandleStore | null;
  private pendingBars: ClosedBar[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private tickBarsWritten = 0;
  private tickBarsDropped = 0;
  private tickWriteFailures = 0;
  private lastTickWriteAt: number | null = null;
  private lastFixup: FixupReport | null = null;
  private readonly priceListeners = new Set<(p: Price) => void>();
  private listenerErrors = 0;
  private readonly consumerCounts: Record<HubConsumer, ConsumerCounters> = {
    positions: { hub: 0, legacy: 0, unpriced: 0, lastHubAt: null, lastUnpricedAt: null },
    tracks: { hub: 0, legacy: 0, unpriced: 0, lastHubAt: null, lastUnpricedAt: null },
  };

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
    this.feed.onPrice((p) => this.emit(p));
    const batcher = new QuoteBatcher(this.governor, (refs) => d.broker.quotes(refs));
    this.poller = new QuotePoller({
      feed: this.feed,
      book: this.book,
      batcher,
      clock: d.clock,
      nearLiveTargetMs: 5000,
      criticalTargetMs: 2000,
      onPrice: (p) => this.emit(p),
    });
    if (d.candles) {
      const builder = new CandleBuilder(TICK_GRACE_MS);
      this.builder = builder;
      this.store = new CandleStore({
        repo: d.candles.repo,
        governor: this.governor,
        clock: d.clock,
        fetch: (ref, interval, from, to) => d.broker.candles(ref, interval, from, to),
        interactiveCallBudget: d.candles.interactiveCallBudget ?? 6,
      });
      this.feed.onPrice((p) => this.queueBars(builder.onPrice(p)));
    } else {
      this.builder = null;
      this.store = null;
    }
  }

  /**
   * Never fails: a broker that is down at boot (Angel outage, expired creds)
   * must not leave the hub half-started. The context set, the poller and the
   * maintenance timer always start; the timer re-reconciles every 30 s, so
   * subscriptions land as soon as the broker answers, and status().lastError
   * says why they have not yet.
   */
  async start(): Promise<void> {
    const now = Date.now();
    for (const ref of this.d.defaults) this.registry.watch(ref, 2, CONTEXT, now);
    this.poller.start();
    this.maintenanceTimer = setInterval(() => {
      this.registry.expire(Date.now());
      void this.reconcileSafely();
    }, 30_000);
    this.maintenanceTimer.unref?.();
    if (this.builder) {
      this.flushTimer = setInterval(() => void this.flushBars(Date.now()), TICK_FLUSH_MS);
      this.flushTimer.unref?.();
    }
    try {
      await this.d.broker.connect();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    await this.reconcileSafely();
  }

  stop(): void {
    this.poller.stop();
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    // Best effort: write every bar whose minute has ended (grace waived). The forming minute is
    // dropped, never stored (no forming bars in the database); the nightly fix-up fills it.
    if (this.builder) void this.flushBars(Date.now() + TICK_GRACE_MS);
    this.governor.dispose();
  }

  /** Reconcile without ever rejecting (callers are timers): record the failure instead. */
  private async reconcileSafely(): Promise<void> {
    try {
      await this.feed.reconcile();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  async watch(ref: InstrumentRef, priority: Priority, owner: string, ttlMs?: number): Promise<void> {
    this.registry.watch(ref, priority, owner, Date.now(), ttlMs);
    await this.feed.reconcile();
  }

  async unwatch(ref: InstrumentRef, owner: string): Promise<void> {
    this.registry.unwatch(ref, owner);
    await this.feed.reconcile();
  }

  /**
   * Replace the open-position set: contracts at priority 0 and their underlyings
   * at priority 1, all under one owner, so neither is ever demoted (spec §5.1).
   * An instrument that is both (a cash holding that is also an option's
   * underlying) stays priority 0.
   */
  async setPositions(refs: readonly InstrumentRef[], underlyings: readonly InstrumentRef[] = []): Promise<void> {
    const next = new Map<string, { ref: InstrumentRef; priority: Priority }>();
    for (const r of underlyings) next.set(refKey(r), { ref: r, priority: 1 });
    for (const r of refs) next.set(refKey(r), { ref: r, priority: 0 });
    const now = Date.now();
    for (const [k, e] of this.positions) if (!next.has(k)) this.registry.unwatch(e.ref, POSITIONS);
    for (const e of next.values()) this.registry.watch(e.ref, e.priority, POSITIONS, now);
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

  /** Every price the hub learns: live ticks AND polled quotes (WS-down P0/P1, near-live). */
  onPrice(fn: (p: Price) => void): () => void {
    this.priceListeners.add(fn);
    return () => {
      this.priceListeners.delete(fn);
    };
  }

  /** A consumer's bug must not stop the feed, the other consumers or the candle builder. */
  private emit(p: Price): void {
    for (const fn of this.priceListeners) {
      try {
        fn(p);
      } catch {
        this.listenerErrors++;
      }
    }
  }

  /** Register several watches, then reconcile once. Never rejects (the failure is in status().lastError). */
  async watchMany(refs: readonly InstrumentRef[], priority: Priority, owner: string, ttlMs?: number): Promise<void> {
    const now = Date.now();
    for (const r of refs) this.registry.watch(r, priority, owner, now, ttlMs);
    await this.reconcileSafely();
  }

  recordConsumer(consumer: HubConsumer, outcome: HubOutcome, count = 1): void {
    if (!(count > 0)) return;
    const c = this.consumerCounts[consumer];
    c[outcome] += count;
    if (outcome === 'hub') c.lastHubAt = Date.now();
    if (outcome === 'unpriced') c.lastUnpricedAt = Date.now();
  }

  get candlesEnabled(): boolean {
    return this.store !== null;
  }

  candles(ref: InstrumentRef, timeframe: Timeframe, from: number, to: number, lane: Lane = LANE.INTERACTIVE): Promise<CandlesResult> {
    if (!this.store) return Promise.reject(new Error('candle store is not enabled (HUB_CANDLES_ENABLED)'));
    return this.store.candles(ref, timeframe, from, to, { lane });
  }

  /** Nightly fix-up for `day` (IST YYYY-MM-DD): instruments with tick bars that day + everything watched. */
  async runFixup(day: string): Promise<FixupReport> {
    if (!this.store || !this.d.candles) throw new Error('candle store is not enabled (HUB_CANDLES_ENABLED)');
    const refs = new Map<string, InstrumentRef>();
    for (const t of await this.d.candles.repo.tickInstruments(istMidnight(day))) {
      refs.set(refKey(t), { exchange: t.exchange, token: t.token, symbol: t.token });
    }
    for (const e of this.registry.entries()) refs.set(refKey(e.ref), e.ref);
    const report = await this.store.fixup(day, [...refs.values()]);
    this.lastFixup = report;
    return report;
  }

  private queueBars(bars: ClosedBar[]): void {
    if (bars.length === 0) return;
    this.pendingBars.push(...bars);
    const over = this.pendingBars.length - MAX_PENDING_BARS;
    if (over > 0) {
      this.pendingBars.splice(0, over);
      this.tickBarsDropped += over;
    }
  }

  /**
   * Close due bars and write everything pending as tick bars. Never rejects: it runs from a
   * timer and stop() as `void`, where a rejection would be unhandled. Anything that throws
   * (closeDue included) counts as a tick write failure; the nightly fix-up rewrites the day.
   */
  private async flushBars(now: number): Promise<void> {
    try {
      const candles = this.d.candles;
      if (!this.builder || !candles) return;
      this.queueBars(this.builder.closeDue(now));
      if (this.pendingBars.length === 0) return;
      const batch = this.pendingBars;
      this.pendingBars = [];
      const byRef = new Map<string, ClosedBar[]>();
      for (const b of batch) {
        const k = refKey(b.ref);
        const list = byRef.get(k);
        if (list) list.push(b);
        else byRef.set(k, [b]);
      }
      for (const bars of byRef.values()) {
        try {
          await candles.repo.upsert('1m', bars[0].ref, bars.map((b) => b.candle), 'tick');
          this.tickBarsWritten += bars.length;
          this.lastTickWriteAt = Date.now();
        } catch {
          // The nightly fix-up rewrites the day from the broker; count, don't retry.
          this.tickWriteFailures++;
        }
      }
    } catch {
      this.tickWriteFailures++;
    }
  }

  private candleStatus(): CandleStatus | null {
    if (!this.builder || !this.store) return null;
    const b = this.builder.stats();
    return {
      building: b.building,
      lateTicks: b.lateTicks,
      tickBarsWritten: this.tickBarsWritten,
      tickBarsDropped: this.tickBarsDropped,
      tickWriteFailures: this.tickWriteFailures,
      lastTickWriteAt: this.lastTickWriteAt,
      ...this.store.metrics(),
      lastFixup: this.lastFixup,
    };
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
      lastError: this.lastError,
      candles: this.candleStatus(),
      consumers: {
        positions: { ...this.consumerCounts.positions },
        tracks: { ...this.consumerCounts.tracks },
        listenerErrors: this.listenerErrors,
        flags: this.d.consumerFlags?.() ?? { positions: false, tracks: false },
      },
    };
  }
}
