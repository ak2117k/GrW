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

  it('throws a clear error for an expiry that is not YYYY-MM-DD with month 01-12', () => {
    expect(() => greekExpiry('13OCT2026')).toThrow(/YYYY-MM-DD/);
    expect(() => greekExpiry('2026-10-1')).toThrow(/YYYY-MM-DD/);
    expect(() => greekExpiry('2026-13-01')).toThrow(/YYYY-MM-DD/);
    expect(() => greekExpiry('2026-00-01')).toThrow(/YYYY-MM-DD/);
    expect(() => greekExpiry('')).toThrow(/YYYY-MM-DD/);
  });

  it('drops a row whose IV is missing, non-numeric or <= 0 (never a silent 0 IV)', () => {
    const base = { strikePrice: '25000', optionType: 'CE', delta: '0.5', gamma: '0.001', theta: '-10', vega: '9' };
    expect(mapOptionGreeks([base])).toEqual([]);
    expect(mapOptionGreeks([{ ...base, impliedVolatility: 'NaN' }])).toEqual([]);
    expect(mapOptionGreeks([{ ...base, impliedVolatility: '0' }])).toEqual([]);
  });

  it('drops a row with IV but a missing or non-numeric Greek', () => {
    const { vega: _vega, ...noVega } = { strikePrice: '25000', optionType: 'CE', delta: '0.5', gamma: '0.001', theta: '-10', vega: '9', impliedVolatility: '13' };
    expect(mapOptionGreeks([noVega])).toEqual([]);
    expect(mapOptionGreeks([{ ...noVega, vega: 'abc' }])).toEqual([]);
    expect(mapOptionGreeks([{ ...noVega, vega: '' }])).toEqual([]);
  });

  it('keeps a row whose Greek is a real numeric 0', () => {
    const rows = mapOptionGreeks([
      { strikePrice: '30000', optionType: 'CE', delta: '0', gamma: '0', theta: '0', vega: '0', impliedVolatility: '20' },
    ]);
    expect(rows).toEqual([{ strike: 30000, optionType: 'CE', iv: 20, delta: 0, gamma: 0, theta: 0, vega: 0 }]);
  });

  it('is [] for anything that is not an array', () => {
    expect(mapOptionGreeks(null)).toEqual([]);
    expect(mapOptionGreeks({ data: [] })).toEqual([]);
  });
});
