import { MarketQuoteResolver } from './market-quote-resolver.service';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';

/**
 * One resolver behind every market-page section.
 *
 * Two broker realities it has to reconcile:
 *  - `marketData` (FULL) quotes most tradables in ONE batched call, but REFUSES
 *    NSE index tokens (999260xx) for most API keys — they come back in
 *    `data.unfetched`. SENSEX (BSE) is quotable, which is why it was the only
 *    index tile with numbers.
 *  - `getCandleData` DOES serve those tokens, so the last two daily candles
 *    give a real LTP and a real previous close.
 *
 * One bad token must never take down a whole section, so anything that resolves
 * by neither path is simply absent from the map.
 */
const tick = (over: Partial<TickData> = {}): TickData => ({
  token: '1594',
  symbol: 'INFY',
  ltp: 1500,
  open: 1490,
  high: 1510,
  low: 1480,
  close: 1450,
  volume: 100,
  timestamp: new Date('2026-08-03T06:00:00Z'),
  ...over,
});

const candle = (ts: string, close: number) => ({
  timestamp: new Date(ts),
  open: close,
  high: close,
  low: close,
  close,
  volume: 0,
});

function makeManager(over: Partial<{
  fetchQuotes: jest.Mock;
  fetchCandles: jest.Mock;
}> = {}) {
  return {
    fetchQuotes: over.fetchQuotes ?? jest.fn().mockResolvedValue(new Map()),
    fetchCandles: over.fetchCandles ?? jest.fn().mockResolvedValue([]),
  };
}

function build(manager: ReturnType<typeof makeManager>) {
  return new MarketQuoteResolver(manager as never);
}

describe('MarketQuoteResolver.resolveQuotes', () => {
  it('returns a quote for every token the broker quoted', async () => {
    const manager = makeManager({
      fetchQuotes: jest.fn().mockResolvedValue(new Map([['1594', tick()]])),
    });
    const out = await build(manager).resolveQuotes('u1', [
      { token: '1594', exchange: 'NSE', symbol: 'INFY' },
    ]);
    expect(out.get('1594')?.ltp).toBe(1500);
    expect(out.get('1594')?.change).toBeCloseTo(50, 6);
  });

  it('sends ONE batched broker call for many tokens', async () => {
    const manager = makeManager();
    await build(manager).resolveQuotes('u1', [
      { token: 'a', exchange: 'NSE' },
      { token: 'b', exchange: 'NSE' },
      { token: 'c', exchange: 'BSE' },
    ]);
    expect(manager.fetchQuotes).toHaveBeenCalledTimes(1);
  });

  it('falls back to daily candles for a token the broker refused', async () => {
    const manager = makeManager({
      fetchQuotes: jest.fn().mockResolvedValue(new Map()), // refused
      fetchCandles: jest.fn().mockResolvedValue([
        candle('2026-07-31T00:00:00Z', 24000),
        candle('2026-08-03T00:00:00Z', 24500),
      ]),
    });
    const out = await build(manager).resolveQuotes('u1', [
      { token: '99926000', exchange: 'NSE', symbol: 'NIFTY' },
    ]);
    expect(out.get('99926000')?.ltp).toBe(24500);
    expect(out.get('99926000')?.close).toBe(24000);
    expect(out.get('99926000')?.change).toBeCloseTo(500, 6);
  });

  it('does NOT spend a candle call on a token the broker already quoted', async () => {
    const manager = makeManager({
      fetchQuotes: jest.fn().mockResolvedValue(new Map([['1594', tick()]])),
    });
    await build(manager).resolveQuotes('u1', [{ token: '1594', exchange: 'NSE' }]);
    expect(manager.fetchCandles).not.toHaveBeenCalled();
  });

  it('omits a token that resolves by neither path', async () => {
    const manager = makeManager({
      fetchQuotes: jest.fn().mockResolvedValue(new Map()),
      fetchCandles: jest.fn().mockResolvedValue([]),
    });
    const out = await build(manager).resolveQuotes('u1', [
      { token: 'dead', exchange: 'NSE' },
    ]);
    expect(out.has('dead')).toBe(false);
  });

  it('still returns the good tokens when the whole batch call throws', async () => {
    // A dead broker session must degrade to the candle path, not blank the page.
    const manager = makeManager({
      fetchQuotes: jest.fn().mockRejectedValue(new Error('no broker creds')),
      fetchCandles: jest.fn().mockResolvedValue([candle('2026-08-03T00:00:00Z', 100)]),
    });
    const out = await build(manager).resolveQuotes('u1', [
      { token: 'x', exchange: 'NSE' },
    ]);
    expect(out.get('x')?.ltp).toBe(100);
  });

  it('does not let one failing candle fallback break the others', async () => {
    const manager = makeManager({
      fetchQuotes: jest.fn().mockResolvedValue(new Map()),
      fetchCandles: jest.fn(async (_u: string, token: string) => {
        if (token === 'bad') throw new Error('boom');
        return [candle('2026-08-03T00:00:00Z', 42)];
      }),
    });
    const out = await build(manager).resolveQuotes('u1', [
      { token: 'bad', exchange: 'NSE' },
      { token: 'good', exchange: 'NSE' },
    ]);
    expect(out.has('bad')).toBe(false);
    expect(out.get('good')?.ltp).toBe(42);
  });

  it('returns an empty map for no refs, without calling the broker', async () => {
    const manager = makeManager();
    const out = await build(manager).resolveQuotes('u1', []);
    expect(out.size).toBe(0);
    expect(manager.fetchQuotes).not.toHaveBeenCalled();
  });

  it('caches the candle fallback so a 5s poll does not hammer the rate limit', async () => {
    const manager = makeManager({
      fetchQuotes: jest.fn().mockResolvedValue(new Map()),
      fetchCandles: jest.fn().mockResolvedValue([candle('2026-08-03T00:00:00Z', 7)]),
    });
    const resolver = build(manager);
    const refs = [{ token: 'idx', exchange: 'NSE' }];
    await resolver.resolveQuotes('u1', refs);
    await resolver.resolveQuotes('u1', refs);
    expect(manager.fetchCandles).toHaveBeenCalledTimes(1);
  });

  it('keeps one user\'s cached fallback out of another user\'s results', async () => {
    const manager = makeManager({
      fetchQuotes: jest.fn().mockResolvedValue(new Map()),
      fetchCandles: jest.fn().mockResolvedValue([candle('2026-08-03T00:00:00Z', 9)]),
    });
    const resolver = build(manager);
    const refs = [{ token: 'idx', exchange: 'NSE' }];
    await resolver.resolveQuotes('u1', refs);
    await resolver.resolveQuotes('u2', refs);
    // Separate broker sessions — a second user must not read the first's cache.
    expect(manager.fetchCandles).toHaveBeenCalledTimes(2);
  });

  it('passes the resolved symbol through to the quote', async () => {
    const manager = makeManager({
      fetchQuotes: jest.fn().mockResolvedValue(new Map([['1594', tick({ symbol: '' })]])),
    });
    const out = await build(manager).resolveQuotes('u1', [
      { token: '1594', exchange: 'NSE', symbol: 'INFY-EQ' },
    ]);
    expect(out.get('1594')?.symbol).toBe('INFY-EQ');
  });
});
