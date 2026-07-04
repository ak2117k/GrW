import { describe, it, expect } from 'vitest';
import { computeTilt } from './tilt';

describe('computeTilt', () => {
  it('is neutral at the center', () => {
    expect(computeTilt(0.5, 0.5)).toEqual({ rotateX: 0, rotateY: 0 });
  });
  it('tilts toward the pointer within ±max', () => {
    const tl = computeTilt(0, 0, 8);
    expect(tl.rotateX).toBeCloseTo(8);   // pointer at top → positive X rotation
    expect(tl.rotateY).toBeCloseTo(-8);  // pointer at left → negative Y rotation
    const br = computeTilt(1, 1, 8);
    expect(br.rotateX).toBeCloseTo(-8);
    expect(br.rotateY).toBeCloseTo(8);
  });
  it('clamps to the provided max', () => {
    const { rotateX, rotateY } = computeTilt(0, 1, 5);
    expect(Math.abs(rotateX)).toBeLessThanOrEqual(5);
    expect(Math.abs(rotateY)).toBeLessThanOrEqual(5);
  });
});
