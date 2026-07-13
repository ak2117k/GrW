import { describe, it, expect } from 'vitest';
import { fmtFillTime } from './PortfolioPage';

// Angel One sends an already-formatted filltime string (or '' when it omits
// the time). fmtFillTime renders it verbatim, collapsing missing/blank values
// to an em-dash — it never re-parses or fabricates a time.
describe('fmtFillTime', () => {
  it('renders a broker-formatted time string verbatim', () => {
    expect(fmtFillTime('13:37:57')).toBe('13:37:57');
  });

  it('passes a full datetime string through unchanged', () => {
    expect(fmtFillTime('2026-07-10 09:30:45')).toBe('2026-07-10 09:30:45');
  });

  it('renders an empty string as an em-dash', () => {
    expect(fmtFillTime('')).toBe('—');
  });

  it('renders a whitespace-only string as an em-dash', () => {
    expect(fmtFillTime('   ')).toBe('—');
  });

  it('trims surrounding whitespace', () => {
    expect(fmtFillTime('  13:37:57  ')).toBe('13:37:57');
  });

  it('is null-safe — null/undefined render as an em-dash', () => {
    expect(fmtFillTime(null)).toBe('—');
    expect(fmtFillTime(undefined)).toBe('—');
  });
});
