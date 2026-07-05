import { describe, it, expect } from 'vitest';
import { formatMoney } from './formatMoney';

// These are Angel One RMS amounts — already in RUPEES (not paise), so there is
// NO /100 conversion. formatMoney just renders a rupee amount with Indian
// digit grouping (lakh/crore) and a leading ₹.
describe('formatMoney', () => {
  it('renders a plain rupee amount with ₹ and no decimals when whole', () => {
    expect(formatMoney(500)).toBe('₹500');
  });

  it('does NOT divide by 100 — the input is already rupees', () => {
    // 125000 rupees stays 1,25,000 rupees (a paise reading would show ₹1,250)
    expect(formatMoney(125000)).toBe('₹1,25,000');
  });

  it('uses Indian (lakh/crore) digit grouping', () => {
    expect(formatMoney(1234567)).toBe('₹12,34,567');
  });

  it('keeps up to two decimals for fractional rupees', () => {
    expect(formatMoney(10523.5)).toBe('₹10,523.5');
    expect(formatMoney(10523.45)).toBe('₹10,523.45');
  });

  it('formats negatives with a leading minus before the ₹', () => {
    expect(formatMoney(-2500)).toBe('-₹2,500');
  });

  it('renders zero as ₹0', () => {
    expect(formatMoney(0)).toBe('₹0');
  });

  it('is null-safe — null/undefined/NaN render as ₹0', () => {
    expect(formatMoney(null)).toBe('₹0');
    expect(formatMoney(undefined)).toBe('₹0');
    expect(formatMoney(Number.NaN)).toBe('₹0');
  });
});
