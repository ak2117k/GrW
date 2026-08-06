import { SR_SUPPORTED_INTERVALS, CHART_TIMEFRAMES } from '@td/shared';
import {
  lookbackDaysFor,
  isIntradayInterval,
  isPositionalInterval,
  isSupportedInterval,
  normalizeInterval,
  INTRADAY_INTERVALS,
  POSITIONAL_INTERVALS,
} from './timeframe-lookback';

describe('timeframe-lookback', () => {
  it('maps each intraday interval to a lookback window giving ~200-400 bars', () => {
    expect(lookbackDaysFor('1m')).toBe(1);
    expect(lookbackDaysFor('3m')).toBe(2);
    expect(lookbackDaysFor('5m')).toBe(5);
    expect(lookbackDaysFor('15m')).toBe(10);
    expect(lookbackDaysFor('30m')).toBe(20);
    expect(lookbackDaysFor('1h')).toBe(45);
  });
  it('maps positional intervals to deep history windows', () => {
    expect(lookbackDaysFor('1d')).toBe(900);
    expect(lookbackDaysFor('1w')).toBe(1825);
    expect(lookbackDaysFor('1mo')).toBe(5475);
  });
  it('defaults unknown intervals to the 15m window (10 days)', () => {
    expect(lookbackDaysFor('bogus')).toBe(10);
  });
  it('recognises the intraday set', () => {
    expect(isIntradayInterval('5m')).toBe(true);
    expect(isIntradayInterval('1d')).toBe(false);
    expect([...INTRADAY_INTERVALS].sort()).toEqual(['15m', '1h', '1m', '30m', '3m', '5m']);
  });
  it('recognises the positional set', () => {
    expect(isPositionalInterval('1d')).toBe(true);
    expect(isPositionalInterval('1w')).toBe(true);
    expect(isPositionalInterval('1mo')).toBe(true);
    expect(isPositionalInterval('5m')).toBe(false);
    expect([...POSITIONAL_INTERVALS].sort()).toEqual(['1d', '1mo', '1w']);
  });
  it('isSupportedInterval covers intraday OR positional', () => {
    expect(isSupportedInterval('15m')).toBe(true);
    expect(isSupportedInterval('1h')).toBe(true);
    expect(isSupportedInterval('1d')).toBe(true);
    expect(isSupportedInterval('1w')).toBe(true);
    expect(isSupportedInterval('1mo')).toBe(true);
    expect(isSupportedInterval('bogus')).toBe(false);
    expect(isSupportedInterval('')).toBe(false);
  });
  /**
   * The regression guard for the roster drift that caused the bug: the toolbar
   * once offered `4h`, which the engine cannot analyse at all. Any timeframe
   * added to the toolbar without engine support fails HERE, not on a user's
   * chart.
   */
  it('every offered chart timeframe is analysable (CHART_TIMEFRAMES ⊆ SR_SUPPORTED_INTERVALS)', () => {
    const unsupported = CHART_TIMEFRAMES.filter((tf) => !isSupportedInterval(tf));
    expect(unsupported).toEqual([]);
  });
  it('derives its supported set from the shared roster, not a parallel list', () => {
    for (const interval of SR_SUPPORTED_INTERVALS) {
      expect(isSupportedInterval(interval)).toBe(true);
    }
    // The intraday/positional split is a partition of that roster.
    expect([...INTRADAY_INTERVALS, ...POSITIONAL_INTERVALS].sort()).toEqual(
      [...SR_SUPPORTED_INTERVALS].sort(),
    );
  });
  it('normalizes Yahoo-style 1M to 1mo, passes everything else through', () => {
    expect(normalizeInterval('1M')).toBe('1mo');
    expect(normalizeInterval('1mo')).toBe('1mo');
    expect(normalizeInterval('1d')).toBe('1d');
    expect(normalizeInterval('15m')).toBe('15m');
  });
});
