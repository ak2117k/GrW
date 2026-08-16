import { describe, it, expect } from 'vitest';
import { isDerivative } from './positionRow';

describe('isDerivative', () => {
  it('is true when the traded contract differs from its underlying', () => {
    // The real shape from Angel: tradingsymbol on NFO, symbolname the stock.
    expect(isDerivative({ symbol: 'BDL25AUG261400CE', underlyingSymbol: 'BDL' })).toBe(true);
    expect(
      isDerivative({ symbol: 'BHARTIARTL25AUG262000CE', underlyingSymbol: 'BHARTIARTL' }),
    ).toBe(true);
    expect(isDerivative({ symbol: 'NIFTY28AUG2524000CE', underlyingSymbol: 'NIFTY' })).toBe(true);
    expect(isDerivative({ symbol: 'RELIANCE28AUG25FUT', underlyingSymbol: 'RELIANCE' })).toBe(true);
  });

  it('is false for cash, where the series suffix is the only difference', () => {
    // `BDL-EQ` and `BDL` are one instrument. Treating them as two would put a
    // second chart link on the row pointing exactly where the first one goes.
    expect(isDerivative({ symbol: 'BDL-EQ', underlyingSymbol: 'BDL' })).toBe(false);
    expect(isDerivative({ symbol: 'SUZLON-BE', underlyingSymbol: 'SUZLON' })).toBe(false);
    expect(isDerivative({ symbol: 'INFY', underlyingSymbol: 'INFY' })).toBe(false);
  });

  it('is false when the broker reported no underlying, rather than guessing one', () => {
    // A guess parsed out of the tradingsymbol would send the link somewhere the
    // broker never claimed — worse than offering no second link at all.
    expect(isDerivative({ symbol: 'BDL25AUG261400CE', underlyingSymbol: null })).toBe(false);
    expect(isDerivative({ symbol: 'BDL25AUG261400CE', underlyingSymbol: '' })).toBe(false);
  });

  it('ignores case and surrounding whitespace on both sides', () => {
    expect(isDerivative({ symbol: ' bdl-eq ', underlyingSymbol: 'BDL' })).toBe(false);
    expect(isDerivative({ symbol: 'BDL-EQ', underlyingSymbol: ' bdl ' })).toBe(false);
  });
});
