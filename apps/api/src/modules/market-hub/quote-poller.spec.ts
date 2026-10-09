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
import type { InstrumentRef, Price } from './hub.types';

const IST = (local: string) => new Date(new Date(`${local}Z`).getTime() - 5.5 * 3600_000).getTime();
const ref = (token: string, exchange: InstrumentRef['exchange'] = 'NSE'): InstrumentRef => ({
  exchange,
  token,
  symbol: token,
});

async function setup(cap: number, onPrice?: (p: Price) => void) {
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
  const poller = new QuotePoller({ feed, book, batcher, clock, nearLiveTargetMs: 5000, criticalTargetMs: 2000, onPrice });
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
    // Socket back and the contract ticking: no Critical-lane quote. (Since the I1 top-up a QUIET
    // live P0 is quoted too, so this needs a tick to keep asserting "socket up ⇒ no safety-net poll".)
    broker.emitTick(FakeBroker.tick('pos', 101, 'NSE'));
    expect(poller.pollCritical()).toBe(0);
  });

  describe('live P0/P1 top-up (a quiet live slot must not age past 5 s)', () => {
    it('a live P0 entry with no ticks for 4 s gets a quote call and stays ≤ 5 s old', async () => {
      const { broker, registry, feed, poller, book } = await setup(5);
      registry.watch(ref('pos'), 0, 'positions', 0);
      await feed.reconcile();
      broker.emitState('live');
      broker.emitTick(FakeBroker.tick('pos', 101, 'NSE'));
      jest.setSystemTime(Date.now() + 4000); // quiet for 4 s
      expect(poller.pollCritical()).toBe(1);
      await jest.advanceTimersByTimeAsync(200);
      expect(broker.quoteCalls).toEqual([[ref('pos')]]);
      expect(book.ageMs('NSE:pos', Date.now())).toBeLessThanOrEqual(5000);
    });

    it('on the real 2 s cadence a quiet live P0 never ages past 5 s, whatever its phase', async () => {
      const { broker, registry, feed, poller, book } = await setup(5);
      registry.watch(ref('pos'), 0, 'positions', 0);
      await feed.reconcile();
      broker.emitState('live');
      poller.start();
      await jest.advanceTimersByTimeAsync(100); // off the sweep phase on purpose
      broker.emitTick(FakeBroker.tick('pos', 101, 'NSE')); // one tick, then silence
      let worst = 0;
      for (let i = 0; i < 300; i++) {
        await jest.advanceTimersByTimeAsync(100);
        worst = Math.max(worst, book.ageMs('NSE:pos', Date.now()) ?? Infinity);
      }
      poller.stop();
      expect(worst).toBeLessThanOrEqual(5000);
    });

    it('a live P0 entry ticking every second is NOT polled', async () => {
      const { broker, registry, feed, poller } = await setup(5);
      registry.watch(ref('pos'), 0, 'positions', 0);
      await feed.reconcile();
      broker.emitState('live');
      broker.emitTick(FakeBroker.tick('pos', 101, 'NSE'));
      poller.start();
      for (let i = 0; i < 20; i++) {
        await jest.advanceTimersByTimeAsync(1000);
        broker.emitTick(FakeBroker.tick('pos', 102 + i, 'NSE'));
      }
      poller.stop();
      expect(broker.quoteCalls).toEqual([]);
    });

    it('a live P2/P3 entry is NOT topped up by this path', async () => {
      const { broker, registry, feed, poller } = await setup(5);
      registry.watch(ref('ctx'), 2, 'context', 0);
      registry.watch(ref('exit'), 3, 'track:exit', 0);
      await feed.reconcile();
      broker.emitState('live');
      jest.setSystemTime(Date.now() + 30_000); // never ticked, 30 s on
      expect(poller.pollCritical()).toBe(0);
      expect(poller.pollNearLive()).toBe(0); // both hold live slots, so near-live skips them too
    });

    it('does not top up a live P0 on a closed exchange', async () => {
      jest.setSystemTime(IST('2026-10-07T16:00:00')); // NSE closed
      const { broker, registry, feed, poller } = await setup(5);
      registry.watch(ref('pos'), 0, 'positions', 0);
      await feed.reconcile();
      broker.emitState('live');
      expect(poller.pollCritical()).toBe(0);
    });
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

  it('hands every polled price to onPrice, stamped as a quote at receipt', async () => {
    const seen: Price[] = [];
    const { registry, feed, poller } = await setup(0, (p) => seen.push(p));
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    poller.pollNearLive();
    await jest.advanceTimersByTimeAsync(200);
    // Received when the 150 ms batch fired (t+150), so 50 ms old at t+200.
    expect(seen).toEqual([{ ref: ref('1'), ltp: 100, at: Date.now() - 50, source: 'quote', volume: 0, oi: undefined }]);
  });

  it('does not call onPrice for a throttled quote', async () => {
    const seen: Price[] = [];
    const { broker, registry, feed, poller } = await setup(0, (p) => seen.push(p));
    broker.quoteImpl = async () => {
      throw new AngelThrottleError('rate');
    };
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    poller.pollNearLive();
    await jest.advanceTimersByTimeAsync(200);
    expect(seen).toEqual([]);
  });
});
