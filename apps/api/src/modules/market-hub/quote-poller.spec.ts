import { QuotePoller } from './quote-poller';
import { LiveFeed } from './live-feed';
import { WatchRegistry } from './watch-registry';
import { PriceBook } from './price-book';
import { QuoteBatcher } from './quote-batcher';
import { DEFAULT_RATES, Governor } from './governor';
import { SessionClock } from './session-clock';
import { FakeBroker } from './testing/fake-broker';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { AngelThrottleError } from '../market-data/services/angel-throttle';
import type { InstrumentRef } from './hub.types';

const IST = (local: string) => new Date(new Date(`${local}Z`).getTime() - 5.5 * 3600_000).getTime();
const ref = (token: string, exchange: InstrumentRef['exchange'] = 'NSE'): InstrumentRef => ({
  exchange,
  token,
  symbol: token,
});

async function setup(cap: number) {
  const broker = new FakeBroker();
  const registry = new WatchRegistry();
  const book = new PriceBook();
  const feed = new LiveFeed({ broker, registry, book, cap });
  const gov = new Governor({
    ratesPerSec: DEFAULT_RATES,
    interactiveDeadlineMs: 5000,
    backgroundTrickleMs: 5000,
    maxBackoffMs: 30_000,
    isMarketHours: () => true,
    isThrottle: (e) => e instanceof AngelThrottleError,
  });
  const batcher = new QuoteBatcher(gov, (refs) => broker.quotes(refs));
  const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
  const poller = new QuotePoller({ feed, book, batcher, clock, nearLiveTargetMs: 5000, criticalTargetMs: 2000 });
  return { broker, registry, book, feed, poller };
}

describe('QuotePoller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(IST('2026-10-07T10:00:00')); // Wednesday, NSE open, MCX open
  });
  afterEach(() => jest.useRealTimers());

  it('polls watched instruments that did not get a live slot', async () => {
    const { broker, registry, feed, poller, book } = await setup(0);
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    expect(poller.pollNearLive()).toBe(1);
    await jest.advanceTimersByTimeAsync(200);
    expect(broker.quoteCalls).toHaveLength(1);
    // Stamped at receipt (the 150 ms batch fired at t+150), so 50 ms old at t+200.
    expect(book.ageMs('NSE:1', Date.now())).toBe(50);
  });

  it('does not poll a closed exchange', async () => {
    jest.setSystemTime(IST('2026-10-07T16:00:00')); // NSE closed, MCX open
    const { registry, feed, poller } = await setup(0);
    registry.watch(ref('1', 'NSE'), 3, 'w', 0);
    registry.watch(ref('2', 'MCX'), 3, 'w', 0);
    await feed.reconcile();
    expect(poller.pollNearLive()).toBe(1);
  });

  it('does not re-poll a price that is still fresh', async () => {
    const { registry, feed, poller } = await setup(0);
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    poller.pollNearLive();
    await jest.advanceTimersByTimeAsync(200);
    expect(poller.pollNearLive()).toBe(0);
  });

  it('polls live P0/P1 instruments on the critical lane while the socket is down', async () => {
    const { broker, registry, feed, poller } = await setup(5);
    registry.watch(ref('pos'), 0, 'positions', 0);
    await feed.reconcile();
    broker.emitState('reconnecting');
    expect(poller.pollCritical()).toBe(1);
    broker.emitState('live');
    jest.setSystemTime(Date.now() + 10_000);
    expect(poller.pollCritical()).toBe(0);
  });

  it('records a throttle as an unavailable reason', async () => {
    const { broker, registry, feed, poller, book } = await setup(0);
    broker.quoteImpl = async () => {
      throw new AngelThrottleError('rate');
    };
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    poller.pollNearLive();
    await jest.advanceTimersByTimeAsync(200);
    expect(
      book.get(ref('1'), { maxAgeMs: 1, now: Date.now(), isOpen: () => true, watched: () => true }),
    ).toEqual({ kind: 'unavailable', reason: 'throttled' });
  });
});
