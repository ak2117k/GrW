import { Prisma } from '@prisma/client';
import { marginFor, marginRefPrice, mtfFunded, proportionalRelease } from './margin';
import { paperSettings } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);
const s = paperSettings();

describe('margin (spec §4.4)', () => {
  it('cash intraday blocks notional ÷ intradayLeverage (E2)', () => {
    expect(marginFor('CASH_INTRADAY', D('50070'), s).toFixed(2)).toBe('10014.00');
  });

  it('MTF blocks the own share, notional × (1 − mtfFundedShare)', () => {
    expect(marginFor('MTF', D('10005'), s).toFixed(2)).toBe('5002.50');
    expect(mtfFunded(D('10005'), s).toFixed(2)).toBe('5002.50');
  });

  it('options block the full premium', () => {
    expect(marginFor('OPTIONS_BUY', D('15000'), s).toFixed(2)).toBe('15000.00');
  });

  it('rounds a block up to the paisa, never under-blocking', () => {
    expect(marginFor('CASH_INTRADAY', D('100.01'), s).toFixed(2)).toBe('20.01');
  });

  it('a LIMIT order blocks at its limit, anything else at refPrice', () => {
    expect(marginRefPrice({ type: 'LIMIT', limitPrice: 99.5, refPrice: 100 }).toFixed(2)).toBe('99.50');
    expect(marginRefPrice({ type: 'MARKET', limitPrice: null, refPrice: 100 }).toFixed(2)).toBe('100.00');
    expect(marginRefPrice({ type: 'SL_MARKET', limitPrice: null, refPrice: 95 }).toFixed(2)).toBe('95.00');
  });

  it('proportional releases add up to the block exactly, with nothing left over', () => {
    let held = D('10000.01');
    let released = D('0');
    for (const [qty, of] of [[3, 7], [2, 4], [2, 2]] as const) {
      const r = proportionalRelease(held, qty, of);
      released = released.plus(r);
      held = held.minus(r);
    }
    expect(released.toFixed(2)).toBe('10000.01');
    expect(held.toFixed(2)).toBe('0.00');
    expect(proportionalRelease(D('100'), 5, 5).toFixed(2)).toBe('100.00');
    expect(proportionalRelease(D('0'), 1, 2).toFixed(2)).toBe('0.00');
    expect(proportionalRelease(D('100'), 1, 0).toFixed(2)).toBe('0.00');
  });
});
