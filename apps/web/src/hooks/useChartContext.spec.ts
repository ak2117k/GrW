import { describe, it, expect } from 'vitest';
import { chartContextParams } from './useChartContext';

describe('chartContextParams', () => {
  it('sends the symbol when the caller knows it', () => {
    // REGRESSION: the composite hook replaced useChartAnalysis(token, exchange,
    // SYMBOL, timeframe) but dropped the symbol. Server-side the resolved
    // symbol gates the analysis, evidence AND trend loaders, and the fallback
    // token->symbol instrument lookup misses for indices — so one missing
    // param emptied all three at once and a NIFTY chart truthfully reported
    // "S/R: none in range".
    expect(chartContextParams('99926000', 'NSE', '15m', 'NIFTY')).toEqual({
      token: '99926000',
      exchange: 'NSE',
      interval: '15m',
      symbol: 'NIFTY',
    });
  });

  it('omits symbol entirely rather than sending an empty one', () => {
    // A blank `symbol=` is worse than none: it defeats the server's own
    // token-lookup fallback for callers that genuinely do not know it.
    for (const missing of [undefined, null, '']) {
      expect(chartContextParams('1594', 'NSE', '15m', missing)).toEqual({
        token: '1594',
        exchange: 'NSE',
        interval: '15m',
      });
    }
  });

  it('defaults a null interval to 15m', () => {
    expect(chartContextParams('1594', 'NSE', null).interval).toBe('15m');
  });

  it('passes positional timeframes through untouched', () => {
    // 1w/1mo reach a different server branch (Yahoo candles); silently
    // rewriting them to 15m would make a weekly chart show intraday levels.
    expect(chartContextParams('1594', 'NSE', '1w').interval).toBe('1w');
    expect(chartContextParams('1594', 'NSE', '1mo').interval).toBe('1mo');
  });
});
