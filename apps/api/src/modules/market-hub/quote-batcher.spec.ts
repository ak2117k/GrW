import { DEFAULT_RATES, Governor } from './governor';
import { chunkRefs, QuoteBatcher } from './quote-batcher';
import { LANE, type InstrumentRef } from './hub.types';
import { AngelThrottleError } from '../market-data/services/angel-throttle';
import type { TickData } from '../../common/interfaces/broker-adapter.interface';

const ref = (token: string, exchange: InstrumentRef['exchange'] = 'NSE'): InstrumentRef => ({
  exchange,
  token,
  symbol: token,
});
const tick = (token: string): TickData => ({
  token,
  symbol: token,
  ltp: 100,
  open: 0,
  high: 0,
  low: 0,
  close: 0,
  volume: 0,
  timestamp: new Date(0),
});
const gov = () =>
  new Governor({
    ratesPerSec: DEFAULT_RATES,
    interactiveDeadlineMs: 5000,
    backgroundTrickleMs: 5000,
    maxBackoffMs: 30_000,
    isMarketHours: () => false,
    isThrottle: (e) => e instanceof AngelThrottleError,
  });

describe('QuoteBatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });
  afterEach(() => jest.useRealTimers());

  it('combines quotes asked within 150 ms into one broker call', async () => {
    const fetch = jest.fn(async (refs: InstrumentRef[]) => new Map(refs.map((r) => [r.token, tick(r.token)])));
    const b = new QuoteBatcher(gov(), fetch);
    const all = Promise.all(['1', '2', '3'].map((t) => b.quote(ref(t), LANE.ROUTINE)));
    await jest.advanceTimersByTimeAsync(150);
    const out = await all;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0].map((r) => r.token)).toEqual(['1', '2', '3']);
    expect(out.every((o) => o.kind === 'ok')).toBe(true);
  });

  it('splits into calls of at most 50 symbols', async () => {
    const fetch = jest.fn(async (refs: InstrumentRef[]) => new Map(refs.map((r) => [r.token, tick(r.token)])));
    const b = new QuoteBatcher(gov(), fetch);
    const all = Promise.all(Array.from({ length: 120 }, (_, i) => b.quote(ref(String(i)), LANE.ROUTINE)));
    await jest.advanceTimersByTimeAsync(2000);
    await all;
    expect(fetch.mock.calls.map((c) => c[0].length)).toEqual([50, 50, 20]);
  });

  it('never puts the same token twice in one call (exchanges collide on tokens)', () => {
    const items = [{ ref: ref('1', 'NSE') }, { ref: ref('1', 'MCX') }, { ref: ref('2', 'NSE') }];
    expect(chunkRefs(items, 50).map((c) => c.map((i) => `${i.ref.exchange}:${i.ref.token}`))).toEqual([
      ['NSE:1', 'NSE:2'],
      ['MCX:1'],
    ]);
  });

  it('reports a token the broker did not quote as missing', async () => {
    const b = new QuoteBatcher(gov(), async () => new Map([['1', tick('1')]]));
    const both = Promise.all([b.quote(ref('1'), LANE.ROUTINE), b.quote(ref('2'), LANE.ROUTINE)]);
    await jest.advanceTimersByTimeAsync(150);
    const [one, two] = await both;
    expect(one.kind).toBe('ok');
    expect(two).toEqual({ kind: 'missing' });
  });

  it('passes a throttle through to every waiter', async () => {
    const b = new QuoteBatcher(gov(), async () => {
      throw new AngelThrottleError('rate');
    });
    const p = b.quote(ref('1'), LANE.ROUTINE);
    await jest.advanceTimersByTimeAsync(150);
    expect(await p).toEqual({ kind: 'throttled', retryAfterMs: 1000 });
  });

  it('submits the batch on the most urgent lane among its members', async () => {
    const g = gov();
    const spy = jest.spyOn(g, 'submit');
    const b = new QuoteBatcher(g, async () => new Map());
    const p = Promise.all([b.quote(ref('1'), LANE.ROUTINE), b.quote(ref('2'), LANE.CRITICAL)]);
    await jest.advanceTimersByTimeAsync(150);
    await p;
    expect(spy.mock.calls[0][0].lane).toBe(LANE.CRITICAL);
  });
});
