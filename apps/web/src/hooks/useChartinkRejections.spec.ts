import { describe, it, expect } from 'vitest';
import { dayRangeFor } from './useChartinkRejections';

describe('dayRangeFor', () => {
  it('builds an ISO range spanning the full local day for a YYYY-MM-DD input', () => {
    const { from, to } = dayRangeFor('2026-05-18');

    const fromD = new Date(from);
    const toD = new Date(to);

    // from is the start of the day, to is the end of the same day
    expect(fromD.getFullYear()).toBe(2026);
    expect(fromD.getMonth()).toBe(4); // May (0-indexed)
    expect(fromD.getDate()).toBe(18);
    expect(fromD.getHours()).toBe(0);
    expect(fromD.getMinutes()).toBe(0);
    expect(fromD.getSeconds()).toBe(0);

    expect(toD.getDate()).toBe(18);
    expect(toD.getHours()).toBe(23);
    expect(toD.getMinutes()).toBe(59);
    expect(toD.getSeconds()).toBe(59);

    // both are valid ISO strings
    expect(Number.isNaN(fromD.getTime())).toBe(false);
    expect(Number.isNaN(toD.getTime())).toBe(false);
    expect(fromD.getTime()).toBeLessThan(toD.getTime());
  });

  it('to is strictly after from and within the same calendar day', () => {
    const { from, to } = dayRangeFor('2026-01-01');
    expect(new Date(from).getDate()).toBe(1);
    expect(new Date(to).getDate()).toBe(1);
    expect(new Date(to).getTime() - new Date(from).getTime()).toBeGreaterThan(
      23 * 60 * 60 * 1000,
    );
  });
});
