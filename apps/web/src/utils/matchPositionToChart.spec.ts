import { describe, it, expect } from 'vitest';
import { chartBaseSymbol, matchesChartSymbol, positionsForChart } from './matchPositionToChart';

describe('chartBaseSymbol', () => {
  it('strips the cash series suffix and normalises', () => {
    expect(chartBaseSymbol('KEI-EQ')).toBe('KEI');
    expect(chartBaseSymbol(' motherson-eq ')).toBe('MOTHERSON');
    expect(chartBaseSymbol('NIFTY')).toBe('NIFTY');
  });
});

describe('matchesChartSymbol', () => {
  it('matches a derivative to its underlying chart', () => {
    expect(matchesChartSymbol('KEI29SEP265800CE', 'KEI-EQ')).toBe(true);
    expect(matchesChartSymbol('HAL25AUG265050CE', 'HAL-EQ')).toBe(true);
    expect(matchesChartSymbol('NIFTY28AUG2524000CE', 'NIFTY')).toBe(true);
    expect(matchesChartSymbol('RELIANCE28AUG25FUT', 'RELIANCE-EQ')).toBe(true);
  });

  it('matches cash to cash regardless of series suffix', () => {
    expect(matchesChartSymbol('MOTHERSON-EQ', 'MOTHERSON')).toBe(true);
    expect(matchesChartSymbol('MOTHERSON-EQ', 'MOTHERSON-EQ')).toBe(true);
    expect(matchesChartSymbol('SUZLON-BE', 'SUZLON-EQ')).toBe(true);
  });

  it('does NOT match a different company that merely shares a prefix', () => {
    // THE REASON THE DIGIT TEST EXISTS. A bare startsWith would draw KEIL's
    // entry, green floor and verdict on KEI's chart, and nothing on screen
    // would tell the user it was the wrong trade.
    expect(matchesChartSymbol('KEIL29SEP265800CE', 'KEI-EQ')).toBe(false);
    expect(matchesChartSymbol('KEIL-EQ', 'KEI-EQ')).toBe(false);
    expect(matchesChartSymbol('HALDIRAM-EQ', 'HAL-EQ')).toBe(false);
    expect(matchesChartSymbol('BAJAJFINSV25AUG26FUT', 'BAJFINANCE-EQ')).toBe(false);
  });

  it('is empty-safe rather than matching everything', () => {
    expect(matchesChartSymbol('KEI29SEP265800CE', '')).toBe(false);
    expect(matchesChartSymbol('', 'KEI-EQ')).toBe(false);
  });
});

describe('positionsForChart', () => {
  it('returns every position on the charted underlying, and only those', () => {
    const positions = [
      { symbol: 'KEI29SEP265800CE' },
      { symbol: 'KEI29SEP266000CE' },
      { symbol: 'KEIL-EQ' },
      { symbol: 'MOTHERSON-EQ' },
    ];
    expect(positionsForChart(positions, 'KEI-EQ').map((p) => p.symbol)).toEqual([
      'KEI29SEP265800CE',
      'KEI29SEP266000CE',
    ]);
  });
});
