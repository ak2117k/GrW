import { describe, expect, it } from 'vitest';
import { bucketLabel, inr, monthLabel, pct, pnlTone, severityVariant, tagVariant } from './portfolioReviewFormat';

describe('portfolio review format', () => {
  it('formats rupees en-IN with a real minus and optional plus', () => {
    expect(inr(-250000)).toBe('−₹2,50,000');
    expect(inr(1234.6, true)).toBe('+₹1,235');
    expect(inr(0)).toBe('₹0');
    expect(inr(null)).toBe('—');
  });
  it('formats percentages', () => {
    expect(pct(-34.12)).toBe('−34.1%');
    expect(pct(5, true)).toBe('+5.0%');
    expect(pct(undefined)).toBe('—');
  });
  it('tones and badge variants', () => {
    expect(pnlTone(-1)).toMatch(/red/);
    expect(pnlTone(1)).toMatch(/green/);
    expect(severityVariant('HIGH')).toBe('danger');
    expect(severityVariant('OK')).toBe('success');
    expect(tagVariant('DEAD-MONEY')).toBe('danger');
    expect(tagVariant('STRONG')).toBe('success');
    expect(tagVariant('NEUTRAL')).toBe('neutral');
  });
  it('labels bucket keys and months', () => {
    expect(bucketLabel('AT_BROKER')).toBe('At the broker');
    expect(bucketLabel('NIFTY')).toBe('NIFTY');
    expect(monthLabel('2026-10')).toMatch(/Oct/);
  });
});
