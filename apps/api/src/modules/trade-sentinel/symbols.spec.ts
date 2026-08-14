import { normaliseSymbol } from './symbols';

describe('normaliseSymbol', () => {
  it('strips the NSE series suffix, which is the whole reason it exists', () => {
    // The broker book spells it one way and the watch tables spell it another.
    expect(normaliseSymbol('SUZLON-EQ')).toBe('SUZLON');
    expect(normaliseSymbol('SUZLON')).toBe('SUZLON');
    // Both sides of the ownership compare must land on the SAME string, which
    // is the property the roster depends on — not merely "is shorter".
    expect(normaliseSymbol('SUZLON-EQ')).toBe(normaliseSymbol('SUZLON'));
  });

  it('collapses the trade-to-trade series onto the same base as -EQ', () => {
    // Deliberately over-broad in the SAFE direction: if an engine holds -BE and
    // the sentinel sees -EQ, the sentinel observes rather than claims.
    expect(normaliseSymbol('RELIANCE-BE')).toBe('RELIANCE');
    expect(normaliseSymbol('RELIANCE-BZ')).toBe('RELIANCE');
  });

  it('leaves a derivative tradingsymbol intact — two strikes are two instruments', () => {
    // This is the dangerous direction: collapsing 24000CE and 24500CE would let
    // ownership of one contract silence the sentinel on a different one.
    expect(normaliseSymbol('NIFTY28AUG2524000CE')).toBe('NIFTY28AUG2524000CE');
    expect(normaliseSymbol('NIFTY28AUG2524500CE')).toBe('NIFTY28AUG2524500CE');
    expect(normaliseSymbol('NIFTY28AUG2524000CE')).not.toBe(
      normaliseSymbol('NIFTY28AUG2524500CE'),
    );
    expect(normaliseSymbol('RELIANCE28AUG25FUT')).toBe('RELIANCE28AUG25FUT');
  });

  it('upper-cases and trims, so a feed that shouts and one that whispers agree', () => {
    expect(normaliseSymbol('  suzlon-eq ')).toBe('SUZLON');
  });

  it('strips at most ONE suffix and only a short one', () => {
    // A four-character tail is not a series code; eating it would merge two
    // genuinely different symbols.
    expect(normaliseSymbol('ABC-WXYZ')).toBe('ABC-WXYZ');
    expect(normaliseSymbol('A-B-EQ')).toBe('A-B');
  });

  it('survives the empty and the absent without throwing', () => {
    expect(normaliseSymbol('')).toBe('');
    expect(normaliseSymbol(undefined as unknown as string)).toBe('');
    expect(normaliseSymbol(null as unknown as string)).toBe('');
  });

  it('never normalises to the empty string, which would bucket unrelated symbols together', () => {
    expect(normaliseSymbol('M&M-EQ')).toBe('M&M');
    // A bare suffix keeps itself rather than collapsing onto ''.
    expect(normaliseSymbol('-EQ')).toBe('-EQ');
  });
});
