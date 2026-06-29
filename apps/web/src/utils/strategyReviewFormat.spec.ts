import { describe, it, expect } from 'vitest';
import { fmtPct, fmtRupees, fmtNumber, fmtCount, signColor } from './strategyReviewFormat';

describe('fmtPct', () => {
  it('formats to 1 decimal with a percent sign', () => {
    expect(fmtPct(62.5)).toBe('62.5%');
    expect(fmtPct(0)).toBe('0.0%');
    expect(fmtPct(33.333)).toBe('33.3%');
  });

  it('returns em-dash for non-finite input', () => {
    expect(fmtPct(NaN)).toBe('—');
    expect(fmtPct(Infinity)).toBe('—');
  });
});

describe('fmtRupees', () => {
  it('applies en-IN grouping with a leading sign', () => {
    expect(fmtRupees(123456.7)).toBe('+₹1,23,457');
    expect(fmtRupees(-2500)).toBe('-₹2,500');
  });

  it('omits the sign for zero', () => {
    expect(fmtRupees(0)).toBe('₹0');
  });

  it('returns em-dash for non-finite input', () => {
    expect(fmtRupees(NaN)).toBe('—');
  });
});

describe('fmtNumber', () => {
  it('formats to 2 decimals by default', () => {
    expect(fmtNumber(1.5)).toBe('1.50');
    expect(fmtNumber(-0.25)).toBe('-0.25');
  });

  it('respects a custom decimal count', () => {
    expect(fmtNumber(1.23456, 3)).toBe('1.235');
  });

  it('returns em-dash for non-finite input', () => {
    expect(fmtNumber(Infinity)).toBe('—');
  });
});

describe('fmtCount', () => {
  it('applies en-IN grouping to integers', () => {
    expect(fmtCount(123456)).toBe('1,23,456');
    expect(fmtCount(0)).toBe('0');
    expect(fmtCount(42)).toBe('42');
  });

  it('rounds fractional input to a whole number', () => {
    expect(fmtCount(12.4)).toBe('12');
    expect(fmtCount(12.6)).toBe('13');
  });

  it('returns em-dash for non-finite input', () => {
    expect(fmtCount(NaN)).toBe('—');
    expect(fmtCount(Infinity)).toBe('—');
  });
});

describe('signColor', () => {
  it('green for positive, red for negative, secondary for zero', () => {
    expect(signColor(10)).toBe('text-emerald-400');
    expect(signColor(-10)).toBe('text-red-400');
    expect(signColor(0)).toBe('text-[var(--color-text-secondary)]');
  });
});
