import { describeUnfetched, quoteFromDailyCandles } from './quote-from-candles';

/**
 * Angel's `marketData` (FULL) will not quote NSE index tokens for most API keys
 * — they come back in `data.unfetched`, not `data.fetched`. SENSEX (BSE) is
 * quotable, which is why it was the only tile with numbers while every
 * `999260xx` NSE index rendered "--".
 *
 * `getCandleData` DOES serve those tokens (it is what draws the charts), so the
 * last two daily candles give a real LTP and a real previous close.
 */
const candle = (ts: string, o: number, h: number, l: number, c: number, v = 0) => ({
  timestamp: new Date(ts),
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe('quoteFromDailyCandles', () => {
  const opts = { token: '99926000', symbol: 'NIFTY', exchange: 'NSE' };

  it('uses the latest candle for OHLC and the prior close as previous close', () => {
    const q = quoteFromDailyCandles(
      [
        candle('2026-07-31T00:00:00Z', 24000, 24100, 23900, 24000),
        candle('2026-08-03T00:00:00Z', 24100, 24600, 24050, 24500),
      ],
      opts,
    );
    expect(q).not.toBeNull();
    expect(q!.ltp).toBe(24500);
    expect(q!.open).toBe(24100);
    expect(q!.high).toBe(24600);
    expect(q!.low).toBe(24050);
    expect(q!.close).toBe(24000); // previous session's close
  });

  it('derives change and changePercent against the previous close', () => {
    const q = quoteFromDailyCandles(
      [
        candle('2026-07-31T00:00:00Z', 1, 1, 1, 24000),
        candle('2026-08-03T00:00:00Z', 24100, 24600, 24050, 24500),
      ],
      opts,
    );
    expect(q!.change).toBeCloseTo(500, 6);
    expect(q!.changePercent).toBeCloseTo((500 / 24000) * 100, 6);
  });

  it('reports a negative change on a down day', () => {
    const q = quoteFromDailyCandles(
      [
        candle('2026-07-31T00:00:00Z', 1, 1, 1, 24000),
        candle('2026-08-03T00:00:00Z', 23900, 24000, 23500, 23600),
      ],
      opts,
    );
    expect(q!.change).toBeCloseTo(-400, 6);
    expect(q!.changePercent).toBeLessThan(0);
  });

  it('sorts by timestamp — a broker chunk may arrive newest-first', () => {
    const q = quoteFromDailyCandles(
      [
        candle('2026-08-03T00:00:00Z', 24100, 24600, 24050, 24500),
        candle('2026-07-31T00:00:00Z', 1, 1, 1, 24000),
      ],
      opts,
    );
    expect(q!.ltp).toBe(24500);
    expect(q!.close).toBe(24000);
  });

  it('zeroes change when only one session is available', () => {
    // No prior close to compare against — better than inventing -100%.
    const q = quoteFromDailyCandles(
      [candle('2026-08-03T00:00:00Z', 24100, 24600, 24050, 24500)],
      opts,
    );
    expect(q!.ltp).toBe(24500);
    expect(q!.change).toBe(0);
    expect(q!.changePercent).toBe(0);
  });

  it('returns null when there are no candles at all', () => {
    expect(quoteFromDailyCandles([], opts)).toBeNull();
  });

  it('carries the identity fields through', () => {
    const q = quoteFromDailyCandles(
      [candle('2026-08-03T00:00:00Z', 1, 2, 0.5, 1.5)],
      opts,
    );
    expect(q!.token).toBe('99926000');
    expect(q!.symbol).toBe('NIFTY');
    expect(q!.exchange).toBe('NSE');
  });
});

describe('describeUnfetched', () => {
  it('summarises each rejected token with its broker reason', () => {
    expect(
      describeUnfetched([
        { exchange: 'NSE', symbolToken: '99926000', message: 'not entitled', errorCode: 'AB4018' },
      ]),
    ).toBe('NSE:99926000 (AB4018 not entitled)');
  });

  it('joins multiple entries', () => {
    const out = describeUnfetched([
      { exchange: 'NSE', symbolToken: '1', message: 'a' },
      { exchange: 'NSE', symbolToken: '2', message: 'b' },
    ]);
    expect(out).toContain('NSE:1');
    expect(out).toContain('NSE:2');
  });

  it('returns an empty string for nothing unfetched', () => {
    expect(describeUnfetched([])).toBe('');
    expect(describeUnfetched(null)).toBe('');
    expect(describeUnfetched(undefined)).toBe('');
  });
});
