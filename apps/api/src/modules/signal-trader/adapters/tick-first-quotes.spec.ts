import { TickFirstQuotes, type TickFeedLike } from './tick-first-quotes';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';

function fakeFeed() {
  let listener: ((userId: string, tick: TickData) => void) | null = null;
  const feed: TickFeedLike & { emit(token: string, ltp: number): void } = {
    subscribe: jest.fn(async () => undefined),
    unsubscribe: jest.fn(async () => undefined),
    addTickListener: (fn) => {
      listener = fn;
      return () => undefined;
    },
    fetchQuote: jest.fn(async () => null),
    emit: (token, ltp) => listener?.('u1', { token, exchange: 'MCX', ltp, symbol: '', open: 0, high: 0, low: 0, close: 0, volume: 0, timestamp: new Date() }),
  };
  return feed;
}

const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));

describe('TickFirstQuotes (2026-11-18 CRUDEOIL 7500 PE dropped for "no fresh quote")', () => {
  it('prices from the live tick and never calls the rate-limited REST quote', async () => {
    const feed = fakeFeed();
    const q = new TickFirstQuotes(feed, { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), tickWaitMs: 200 });
    const p = q.ltp('u1', '586077', 'MCX');
    await new Promise((r) => setTimeout(r, 5));
    feed.emit('586077', 286.4);
    await expect(p).resolves.toBe(286.4);
    expect(feed.subscribe).toHaveBeenCalledWith('u1', [{ token: '586077', exchange: 'MCX' }]);
    expect(feed.fetchQuote).not.toHaveBeenCalled();
  });

  it('a fresh tick is reused without waiting', async () => {
    const feed = fakeFeed();
    const q = new TickFirstQuotes(feed, { sleep: fastSleep });
    const first = q.ltp('u1', '586077', 'MCX');
    await new Promise((r) => setTimeout(r, 1));
    feed.emit('586077', 285);
    await first;
    feed.emit('586077', 287);
    await expect(q.ltp('u1', '586077', 'MCX')).resolves.toBe(287);
    expect(feed.subscribe).toHaveBeenCalledTimes(1);
  });

  it('no tick: falls back to REST and retries past a rate-limit error', async () => {
    const feed = fakeFeed();
    (feed.fetchQuote as jest.Mock)
      .mockRejectedValueOnce(new Error('Access denied because of exceeding access rate'))
      .mockResolvedValueOnce({ ltp: 284.9 });
    const q = new TickFirstQuotes(feed, { sleep: fastSleep });
    await expect(q.ltp('u1', '586077', 'MCX')).resolves.toBe(284.9);
    expect(feed.fetchQuote).toHaveBeenCalledTimes(2);
  });

  it('nothing answers: null after the REST tries', async () => {
    const feed = fakeFeed();
    const q = new TickFirstQuotes(feed, { sleep: fastSleep, restTries: 2 });
    await expect(q.ltp('u1', '586077', 'MCX')).resolves.toBeNull();
    expect(feed.fetchQuote).toHaveBeenCalledTimes(2);
  });

  it('ticks for contracts it is not pricing are ignored', async () => {
    const feed = fakeFeed();
    const q = new TickFirstQuotes(feed, { sleep: fastSleep, restTries: 1 });
    feed.emit('999', 10);
    await expect(q.ltp('u1', '999', 'MCX')).resolves.toBeNull();
  });
});
