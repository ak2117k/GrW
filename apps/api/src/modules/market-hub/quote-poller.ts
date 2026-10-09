import { LANE, refKey, type InstrumentRef, type Lane, type Price } from './hub.types';
import type { LiveFeed } from './live-feed';
import type { PriceBook } from './price-book';
import type { QuoteBatcher, QuoteOutcome } from './quote-batcher';
import type { SessionClock } from './session-clock';
import type { WatchEntry } from './watch-registry';
import { tickExtras } from './tick-extras';

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
 * A live P0/P1 slot that has sent no tick is topped up with a quote so its
 * price is never older than this when the next Critical sweep runs. A live
 * slot's price is stamped at receipt, so a held but illiquid contract would
 * otherwise age without bound and miss the 5 s position bound.
 */
export const LIVE_TOPUP_TARGET_MS = 4000;
/** The Critical sweep cadence (start()'s default). */
const CRITICAL_EVERY_MS = 2000;

/**
 * The near-live tier (every ~5 s for watched instruments without a live slot)
 * and the safety net (every ~2 s, Critical lane): P0/P1 when the socket is
 * down or they overflowed the cap, and quiet live P0/P1 slots (the top-up).
 * Never polls a closed exchange.
 */
export class QuotePoller {
  private timers: ReturnType<typeof setInterval>[] = [];
  private criticalEveryMs = CRITICAL_EVERY_MS;

  constructor(private readonly d: QuotePollerDeps) {}

  pollNearLive(now: number = Date.now()): number {
    return this.poll(this.d.feed.allocation().nearLive, this.d.nearLiveTargetMs, LANE.ROUTINE, now);
  }

  pollCritical(now: number = Date.now()): number {
    const alloc = this.d.feed.allocation();
    const liveCritical = alloc.live.filter((e) => e.priority <= 1);
    if (!this.d.feed.wsHealthy) {
      return this.poll([...liveCritical, ...alloc.criticalOverflow], this.d.criticalTargetMs, LANE.CRITICAL, now);
    }
    // Top-up: poll() skips anything younger than its threshold, so a ticking
    // (liquid) contract costs nothing. The threshold is the target minus one sweep:
    // a slot skipped now is checked again one sweep later, so a quote is asked
    // before the price can pass LIVE_TOPUP_TARGET_MS (a bare 4 s threshold on a
    // 2 s sweep lets a price reach ~6 s, past the 5 s bound).
    const topUpAtMs = Math.max(0, LIVE_TOPUP_TARGET_MS - this.criticalEveryMs);
    return (
      this.poll(alloc.criticalOverflow, this.d.criticalTargetMs, LANE.CRITICAL, now) +
      this.poll(liveCritical, topUpAtMs, LANE.CRITICAL, now)
    );
  }

  start(nearLiveEveryMs = 5000, criticalEveryMs = CRITICAL_EVERY_MS): void {
    this.stop();
    this.criticalEveryMs = criticalEveryMs;
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
        ...tickExtras(o.tick),
      };
      this.d.book.set(price);
      this.d.onPrice?.(price);
    } else if (o.kind === 'throttled') {
      this.d.book.markFailure(refKey(ref), 'throttled');
    }
  }
}
