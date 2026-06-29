import { lookbackDaysFor, isIntradayInterval, INTRADAY_INTERVALS } from './timeframe-lookback';

describe('timeframe-lookback', () => {
  it('maps each intraday interval to a lookback window giving ~200-400 bars', () => {
    expect(lookbackDaysFor('1m')).toBe(1);
    expect(lookbackDaysFor('3m')).toBe(2);
    expect(lookbackDaysFor('5m')).toBe(5);
    expect(lookbackDaysFor('15m')).toBe(10);
    expect(lookbackDaysFor('30m')).toBe(20);
    expect(lookbackDaysFor('1h')).toBe(45);
  });
  it('defaults unknown intervals to the 15m window (10 days)', () => {
    expect(lookbackDaysFor('1d')).toBe(10);
    expect(lookbackDaysFor('bogus')).toBe(10);
  });
  it('recognises the intraday set', () => {
    expect(isIntradayInterval('5m')).toBe(true);
    expect(isIntradayInterval('1d')).toBe(false);
    expect([...INTRADAY_INTERVALS].sort()).toEqual(['15m', '1h', '1m', '30m', '3m', '5m']);
  });
});
