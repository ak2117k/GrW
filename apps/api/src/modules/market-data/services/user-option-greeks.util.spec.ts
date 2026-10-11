import { greekExpiry, mapOptionGreeks } from './user-option-greeks.util';

describe('optionGreek helpers', () => {
  it('formats a YYYY-MM-DD expiry as Angel DDMMMYYYY', () => {
    expect(greekExpiry('2026-10-13')).toBe('13OCT2026');
    expect(greekExpiry('2026-01-05')).toBe('05JAN2026');
  });

  it('maps Angel rows (string numbers, percent IV) and drops rows without a strike or side', () => {
    const rows = mapOptionGreeks([
      { name: 'NIFTY', expiry: '13OCT2026', strikePrice: '25000.000000', optionType: 'CE', delta: '0.52', gamma: '0.0011', theta: '-12.5', vega: '9.8', impliedVolatility: '13.36', tradeVolume: '100' },
      { strikePrice: '25000', optionType: 'PE', delta: '-0.48', gamma: '0.0011', theta: '-11', vega: '9.8', impliedVolatility: '14.1' },
      { strikePrice: '0', optionType: 'CE', delta: '1' },
      { strikePrice: '25100', optionType: 'XX' },
    ]);
    expect(rows).toEqual([
      { strike: 25000, optionType: 'CE', iv: 13.36, delta: 0.52, gamma: 0.0011, theta: -12.5, vega: 9.8 },
      { strike: 25000, optionType: 'PE', iv: 14.1, delta: -0.48, gamma: 0.0011, theta: -11, vega: 9.8 },
    ]);
  });

  it('is [] for anything that is not an array', () => {
    expect(mapOptionGreeks(null)).toEqual([]);
    expect(mapOptionGreeks({ data: [] })).toEqual([]);
  });
});
