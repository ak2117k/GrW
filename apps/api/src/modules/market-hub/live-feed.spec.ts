import { LiveFeed } from './live-feed';
import { WatchRegistry } from './watch-registry';
import { PriceBook } from './price-book';
import { FakeBroker } from './testing/fake-broker';
import type { InstrumentRef } from './hub.types';

const ref = (token: string, exchange: InstrumentRef['exchange'] = 'NSE'): InstrumentRef => ({
  exchange,
  token,
  symbol: token,
});

function setup(cap = 2) {
  const broker = new FakeBroker();
  const registry = new WatchRegistry();
  const book = new PriceBook();
  const feed = new LiveFeed({ broker, registry, book, cap });
  return { broker, registry, book, feed };
}

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
});
