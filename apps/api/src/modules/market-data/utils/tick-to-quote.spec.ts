import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import { tickToQuote } from './tick-to-quote';

/**
 * `GET /instruments/:token/quote` promises a `Quote` — the shape the frontend's
 * LiveQuoteCard renders, including `change` / `changePercent` / `exchange`.
 * The per-user broker path produces a `TickData`, which has none of those, so it
 * MUST be adapted before it leaves the controller. Returning the raw tick makes
 * `q.change.toFixed(2)` throw and takes the whole page down.
 */
function tick(over: Partial<TickData> = {}): TickData {
  return {
    token: '99926000',
    symbol: 'NIFTY',
    ltp: 24_500,
    open: 24_400,
    high: 24_600,
    low: 24_350,
    close: 24_000,
    volume: 1_000,
    timestamp: new Date('2026-08-01T10:00:00Z'),
    ...over,
  };
}

describe('tickToQuote', () => {
  it('carries every numeric field the Quote contract requires', () => {
    const q = tickToQuote(tick(), { exchange: 'NSE' });
    for (const key of [
      'ltp',
      'open',
      'high',
      'low',
      'close',
      'volume',
      'change',
      'changePercent',
    ] as const) {
      expect(typeof q[key]).toBe('number');
      expect(Number.isNaN(q[key])).toBe(false);
    }
    expect(q.exchange).toBe('NSE');
    expect(q.token).toBe('99926000');
  });

  it('derives change and changePercent from the previous close', () => {
    const q = tickToQuote(tick({ ltp: 24_500, close: 24_000 }), { exchange: 'NSE' });
    expect(q.change).toBeCloseTo(500, 6);
    expect(q.changePercent).toBeCloseTo((500 / 24_000) * 100, 6);
  });

  it('reports a negative change when the price is below the previous close', () => {
    const q = tickToQuote(tick({ ltp: 23_500, close: 24_000 }), { exchange: 'NSE' });
    expect(q.change).toBeCloseTo(-500, 6);
    expect(q.changePercent).toBeLessThan(0);
  });

  it('zeroes change rather than reporting a misleading -100% when close is 0', () => {
    // Mirrors the level-book branch: an unknown prev-close must not render as
    // a total loss.
    const q = tickToQuote(tick({ ltp: 24_500, close: 0 }), { exchange: 'NSE' });
    expect(q.change).toBe(0);
    expect(q.changePercent).toBe(0);
  });

  it('zeroes change when there is no traded price yet', () => {
    const q = tickToQuote(tick({ ltp: 0, close: 24_000 }), { exchange: 'NSE' });
    expect(q.change).toBe(0);
    expect(q.changePercent).toBe(0);
  });

  it('falls back to the resolved symbol when the broker sends a blank one', () => {
    // SNAP_QUOTE / FULL responses often carry an empty tradingSymbol.
    const q = tickToQuote(tick({ symbol: '' }), { exchange: 'NSE', symbol: 'NIFTY 50' });
    expect(q.symbol).toBe('NIFTY 50');
  });

  it('prefers the broker-supplied symbol when present', () => {
    const q = tickToQuote(tick({ symbol: 'SBIN-EQ' }), { exchange: 'NSE', symbol: 'SBIN' });
    expect(q.symbol).toBe('SBIN-EQ');
  });

  it('coerces a non-finite broker number to 0 instead of emitting NaN', () => {
    // NaN survives JSON as null and crashes toFixed() on the client just the
    // same as undefined did.
    const q = tickToQuote(tick({ ltp: NaN, close: NaN }), { exchange: 'NSE' });
    expect(q.ltp).toBe(0);
    expect(q.change).toBe(0);
    expect(q.changePercent).toBe(0);
  });

  it('passes open interest through when the broker reported it', () => {
    const q = tickToQuote(tick({ oi: 12_345 }), { exchange: 'NSE' });
    expect(q.oi).toBe(12_345);
  });
});
