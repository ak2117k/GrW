import { describe, it, expect } from 'vitest';
import { progressPct } from './monitorMath';

describe('progressPct', () => {
  it('is 0 when no progress has been made', () => {
    expect(progressPct(0, 5)).toBe(0);
  });

  it('reports partial progress as a percentage of the target', () => {
    expect(progressPct(2.5, 5)).toBe(50);
    expect(progressPct(1, 4)).toBe(25);
  });

  it('clamps to 100 once the target is reached or exceeded', () => {
    expect(progressPct(5, 5)).toBe(100);
    expect(progressPct(7.5, 5)).toBe(100);
  });

  it('clamps negative movement (below reference) to 0', () => {
    expect(progressPct(-3, 5)).toBe(0);
  });

  it('is null-safe on currentPercent', () => {
    expect(progressPct(null, 5)).toBe(0);
    expect(progressPct(undefined, 5)).toBe(0);
    expect(progressPct(NaN, 5)).toBe(0);
  });

  it('yields 0 for a missing or non-positive target (no valid denominator)', () => {
    expect(progressPct(2, null)).toBe(0);
    expect(progressPct(2, undefined)).toBe(0);
    expect(progressPct(2, 0)).toBe(0);
    expect(progressPct(2, -5)).toBe(0);
  });
});
