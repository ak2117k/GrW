import { describe, it, expect } from 'vitest';
import { fixedOrDash } from './fixedOrDash';

describe('fixedOrDash', () => {
  it('formats a real number with the requested decimals', () => {
    expect(fixedOrDash(1.23456)).toBe('1.23');
    expect(fixedOrDash(0, 1)).toBe('0.0');
  });

  it('renders an em dash for a missing reading instead of throwing', () => {
    // Regression: SignalCard called setupContext.volumeRatio.toFixed(2) and the
    // API sends volumeRatio: null for index signals -> "Cannot read properties
    // of null (reading 'toFixed')" took the page down.
    expect(fixedOrDash(null)).toBe('—');
    expect(fixedOrDash(undefined)).toBe('—');
    expect(fixedOrDash(Number.NaN)).toBe('—');
  });
});
