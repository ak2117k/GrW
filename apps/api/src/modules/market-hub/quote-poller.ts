import { LANE, refKey, type InstrumentRef, type Lane, type Price } from './hub.types';
import type { LiveFeed } from './live-feed';
import type { PriceBook } from './price-book';
import type { QuoteBatcher, QuoteOutcome } from './quote-batcher';
import type { SessionClock } from './session-clock';
import type { WatchEntry } from './watch-registry';

export interface QuotePollerDeps {
  feed: LiveFeed;
  book: PriceBook;
  batcher: QuoteBatcher;
  clock: SessionClock;
  nearLiveTargetMs: number;
  criticalTargetMs: number;
  /** Called with every price this poller stores (the engine fans it out to consumers). */
  onPrice?: (p: Price) => void;
}

/**
 * The near-live tier (every ~5 s for watched instruments without a live slot)
 * and the safety net (every ~2 s, Critical lane, for P0/P1 when the socket is
 * down or they overflowed the cap). Never polls a closed exchange.
 */
export class QuotePoller {
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly d: QuotePollerDeps) {}

  pollNearLive(now: number = Date.now()): number {
    return this.poll(this.d.feed.allocation().nearLive, this.d.nearLiveTargetMs, LANE.ROUTINE, now);
  }

  pollCritical(now: number = Date.now()): number {
    const alloc = this.d.feed.allocation();
    const socketDown = this.d.feed.wsHealthy
      ? []
      : alloc.live.filter((e) => e.priority <= 1);
    return this.poll([...socketDown, ...alloc.criticalOverflow], this.d.criticalTargetMs, LANE.CRITICAL, now);
  }

  start(nearLiveEveryMs = 5000, criticalEveryMs = 2000): void {
    this.stop();
    const near = setInterval(() => this.pollNearLive(), nearLiveEveryMs);
    const crit = setInterval(() => this.pollCritical(), criticalEveryMs);
    near.unref?.();
    crit.unref?.();
    this.timers = [near, crit];
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private poll(entries: readonly WatchEntry[], targetMs: number, lane: Lane, now: number): number {
    const at = new Date(now);
    let asked = 0;
    for (const e of entries) {
      if (!this.d.clock.isOpen(e.ref.exchange, at)) continue;
      const age = this.d.book.ageMs(refKey(e.ref), now);
      if (age !== undefined && age < targetMs) continue;
      asked++;
      void this.d.batcher.quote(e.ref, lane).then((o) => this.apply(e.ref, o));
    }
    return asked;
  }

  private apply(ref: InstrumentRef, o: QuoteOutcome): void {
    if (o.kind === 'ok') {
      const price: Price = {
        ref,
        ltp: o.tick.ltp,
        at: Date.now(),
        source: 'quote',
        volume: o.tick.volume,
        oi: o.tick.oi,
      };
      this.d.book.set(price);
      this.d.onPrice?.(price);
    } else if (o.kind === 'throttled') {
      this.d.book.markFailure(refKey(ref), 'throttled');
    }
  }
}
