import { describe, expect, it } from 'vitest';
import { fmtNumOrDash, fmtPriceOrDash } from './formatQuote';

/**
 * LiveQuoteCard renders numbers straight off a payload that crosses a network
 * boundary. Calling `.toFixed()` on a field the backend didn't send throws
 * during render, which unmounts the whole tree — a blank page caused by one
 * absent number. These formatters make a missing/!finite value degrade to "—".
 *
 * This is defence in depth, NOT the fix: the quote endpoint is contracted to
 * send `change`/`changePercent` (see tick-to-quote.ts). A dash here means the
 * producer is wrong and should be found, but the user still sees a page.
 */
describe('fmtNumOrDash', () => {
  it('formats a finite number to fixed decimals', () => {
    expect(fmtNumOrDash(24500.456)).toBe('24500.46');
  });

  it('formats zero rather than dashing it', () => {
    // 0 is a legitimate change value (flat) — distinct from "unknown".
    expect(fmtNumOrDash(0)).toBe('0.00');
  });

  it('formats a negative number', () => {
    expect(fmtNumOrDash(-12.5)).toBe('-12.50');
  });

  it('dashes undefined', () => {
    expect(fmtNumOrDash(undefined)).toBe('—');
  });

  it('dashes null', () => {
    expect(fmtNumOrDash(null as unknown as number)).toBe('—');
  });

  it('dashes NaN', () => {
    expect(fmtNumOrDash(NaN)).toBe('—');
  });

  it('dashes Infinity', () => {
    expect(fmtNumOrDash(Infinity)).toBe('—');
  });

  it('honours a custom precision', () => {
    expect(fmtNumOrDash(1.23456, 4)).toBe('1.2346');
  });
});

describe('fmtPriceOrDash', () => {
  it('formats a positive price', () => {
    expect(fmtPriceOrDash(24500)).toBe('24500.00');
  });

  it('dashes 0 — an untracked field, not a real price', () => {
    // The level-book-seeded quote reports 0 for Day H/L/Open before the first
    // tick; "0.00" would read as a real price.
    expect(fmtPriceOrDash(0)).toBe('—');
  });

  it('dashes undefined', () => {
    expect(fmtPriceOrDash(undefined)).toBe('—');
  });

  it('dashes NaN', () => {
    expect(fmtPriceOrDash(NaN)).toBe('—');
  });
});
