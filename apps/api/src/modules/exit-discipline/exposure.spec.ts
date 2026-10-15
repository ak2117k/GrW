import { contractKindOf, exposureOf } from './exposure';

describe('contractKindOf', () => {
  it.each([
    ['CRUDEOIL17NOV269000CE', 'CE'], ['NIFTY28OCT2624000PE', 'PE'], ['CRUDEOIL19NOV26FUT', 'FUT'],
    ['NIFTY28OCT26FUT', 'FUT'], ['RELIANCE-EQ', 'CASH'], ['RELIANCE', 'CASH'], ['', 'CASH'],
  ])('%s → %s', (s, k) => expect(contractKindOf(s)).toBe(k));
});

describe('exposureOf — direction the UNDERLYING must move to help the position', () => {
  it.each([
    ['CRUDEOIL17NOV269000CE', 'LONG', 'BULLISH'], ['CRUDEOIL17NOV269000CE', 'SHORT', 'BEARISH'],
    ['NIFTY28OCT2624000PE', 'LONG', 'BEARISH'], ['NIFTY28OCT2624000PE', 'SHORT', 'BULLISH'],
    ['CRUDEOIL19NOV26FUT', 'LONG', 'BULLISH'], ['CRUDEOIL19NOV26FUT', 'SHORT', 'BEARISH'],
    ['RELIANCE-EQ', 'LONG', 'BULLISH'], ['RELIANCE-EQ', 'SHORT', 'BEARISH'],
  ] as const)('%s %s → %s', (s, side, e) => expect(exposureOf(s, side)).toBe(e));
});
