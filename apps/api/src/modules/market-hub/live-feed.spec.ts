import { LiveFeed } from './live-feed';
import { WatchRegistry } from './watch-registry';
import { PriceBook } from './price-book';
import { FakeBroker } from './testing/fake-broker';
import { refKey, type InstrumentRef, type Price } from './hub.types';

const ref = (token: string, exchange: InstrumentRef['exchange'] = 'NSE'): InstrumentRef => ({
  exchange,
  token,
  symbol: token,
});

function setup(cap = 2, broker: FakeBroker = new FakeBroker()) {
  const registry = new WatchRegistry();
  const book = new PriceBook();
  const feed = new LiveFeed({ broker, registry, book, cap });
  return { broker, registry, book, feed };
}

/** A broker whose subscribe() parks until the test releases (or fails) it; records overlap. */
class GatedBroker extends FakeBroker {
  readonly subscribeCalls: string[][] = [];
  inFlight = 0;
  maxInFlight = 0;
  private readonly gates: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  override async subscribe(refs: InstrumentRef[]): Promise<void> {
    this.subscribeCalls.push(refs.map(refKey).sort());
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise<void>((resolve, reject) => this.gates.push({ resolve, reject }));
      await super.subscribe(refs);
    } finally {
      this.inFlight--;
    }
  }

  get pending(): number {
    return this.gates.length;
  }
  release(): void {
    this.gates.shift()!.resolve();
  }
  fail(err: Error): void {
    this.gates.shift()!.reject(err);
  }
}

/** Let every queued promise callback run. */
const settle = () => new Promise((r) => setImmediate(r));

describe('LiveFeed', () => {
  it('subscribes the highest-priority watches up to the cap', async () => {
    const { broker, registry, feed } = setup(2);
    registry.watch(ref('pos'), 0, 'positions', 0);
    registry.watch(ref('nifty'), 2, 'context', 0);
    registry.watch(ref('chart'), 4, 'ui', 0);
    await feed.reconcile();
    expect([...broker.subscribed].sort()).toEqual(['NSE:nifty', 'NSE:pos']);
  });

  it('demotes the lowest priority when a more urgent watch arrives, and counts it', async () => {
    const { broker, registry, feed } = setup(2);
    registry.watch(ref('nifty'), 2, 'context', 0);
    registry.watch(ref('chart'), 4, 'ui', 0);
    await feed.reconcile();
    registry.watch(ref('pos'), 0, 'positions', 1);
    await feed.reconcile();
    expect(broker.subscribed.has('NSE:chart')).toBe(false);
    expect(feed.metrics().demotionsTotal).toBe(1);
  });

  it('writes ticks for live instruments into the price book with receipt time', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(50_000);
    const { broker, registry, book, feed } = setup();
    registry.watch(ref('35001', 'NFO'), 0, 'positions', 0);
    await feed.reconcile();
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    expect(book.ageMs('NFO:35001', 50_000)).toBe(0);
    jest.useRealTimers();
  });

  it('ignores ticks for tokens it did not subscribe (the browser shares the socket)', async () => {
    const { broker, book, feed } = setup();
    await feed.reconcile();
    broker.emitTick(FakeBroker.tick('999', 1, 'NSE'));
    expect(book.size()).toBe(0);
  });

  it('resolves a tick without an exchange by token when unambiguous', async () => {
    const { broker, registry, book, feed } = setup();
    registry.watch(ref('7'), 2, 'context', 0);
    await feed.reconcile();
    broker.emitTick(FakeBroker.tick('7', 10));
    expect(book.size()).toBe(1);
  });

  it('tracks socket health from broker states', () => {
    const { broker, feed } = setup();
    expect(feed.wsHealthy).toBe(false);
    broker.emitState('live');
    expect(feed.wsHealthy).toBe(true);
    broker.emitState('reconnecting');
    expect(feed.wsHealthy).toBe(false);
  });

  describe('reconcile is single-flight', () => {
    it('never overlaps broker calls: concurrent callers wait for the run in flight and share ONE trailing run', async () => {
      const broker = new GatedBroker();
      const { registry, feed } = setup(10, broker);
      registry.watch(ref('a'), 0, 'positions', 0);
      const first = feed.reconcile();
      await settle();
      registry.watch(ref('b'), 0, 'positions', 1);
      const second = feed.reconcile();
      const third = feed.reconcile();
      await settle();
      // Only the first run has reached the broker.
      expect(broker.subscribeCalls).toEqual([['NSE:a']]);
      broker.release();
      await first;
      await settle();
      // One trailing run serves both waiting callers, and it starts only after the first finished.
      expect(broker.subscribeCalls).toEqual([['NSE:a'], ['NSE:b']]);
      broker.release();
      const [s2, s3] = await Promise.all([second, third]);
      expect(s2).toBe(s3);
      expect(broker.maxInFlight).toBe(1);
      expect(broker.subscribeCalls).toHaveLength(2);
      expect([...broker.subscribed].sort()).toEqual(['NSE:a', 'NSE:b']);
      expect(feed.metrics().live).toBe(2);
    });

    it('a registry change made during a run is subscribed by the trailing run', async () => {
      const broker = new GatedBroker();
      const { registry, feed } = setup(10, broker);
      registry.watch(ref('a'), 0, 'positions', 0);
      const first = feed.reconcile();
      await settle();
      // Changed mid-run: the in-flight run computed its plan without it.
      registry.watch(ref('late', 'NFO'), 1, 'positions', 1);
      registry.unwatch(ref('a'), 'positions');
      const trailing = feed.reconcile();
      broker.release();
      const firstAlloc = await first;
      expect(firstAlloc.live.map((e) => refKey(e.ref))).toEqual(['NSE:a']);
      await settle();
      broker.release();
      const alloc = await trailing;
      expect(alloc.live.map((e) => refKey(e.ref))).toEqual(['NFO:late']);
      expect([...broker.subscribed]).toEqual(['NFO:late']);
      expect(broker.subscribeCalls).toEqual([['NSE:a'], ['NFO:late']]);
    });

    it('a rejected run rejects only its own callers and does not wedge later runs', async () => {
      const broker = new GatedBroker();
      const { registry, feed } = setup(10, broker);
      registry.watch(ref('a'), 0, 'positions', 0);
      const failing = feed.reconcile();
      const failed = failing.then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      await settle();
      const waiting = feed.reconcile();
      expect(broker.pending).toBe(1);
      broker.fail(new Error('subscribe refused'));
      expect(await failed).toBe('subscribe refused');
      // Live is unchanged by the failure, so the trailing run retries the subscribe.
      expect(feed.metrics().live).toBe(0);
      await settle();
      expect(broker.subscribeCalls).toEqual([['NSE:a'], ['NSE:a']]);
      broker.release();
      await expect(waiting).resolves.toBeDefined();
      expect(feed.metrics().live).toBe(1);
      // And the feed keeps reconciling after that.
      registry.watch(ref('b'), 0, 'positions', 1);
      const later = feed.reconcile();
      await settle();
      broker.release();
      await later;
      expect([...broker.subscribed].sort()).toEqual(['NSE:a', 'NSE:b']);
      expect(broker.maxInFlight).toBe(1);
    });
  });

  it('carries a tick’s day bar and depth onto the price; a tick that reports neither carries neither', async () => {
    const { broker, registry, feed } = setup();
    registry.watch(ref('2885'), 4, 'browser:s1', 0);
    await feed.reconcile();
    const seen: Price[] = [];
    feed.onPrice((p) => seen.push(p));
    broker.emitTick({
      ...FakeBroker.tick('2885', 1500.5, 'NSE'),
      open: 1490,
      high: 1502,
      low: 1488,
      close: 1495,
      depth: { bids: [{ price: 1500.4, qty: 3, orders: 1 }], asks: [] },
    });
    broker.emitTick(FakeBroker.tick('2885', 1501, 'NSE'));
    expect(seen[0].day).toEqual({ open: 1490, high: 1502, low: 1488, close: 1495 });
    expect(seen[0].depth).toEqual({ bids: [{ price: 1500.4, qty: 3, orders: 1 }], asks: [] });
    expect(seen[1]).not.toHaveProperty('day');
    expect(seen[1]).not.toHaveProperty('depth');
  });
});
