import { describe, it, expect } from 'vitest';
import { buildChartTimeResolver } from '../mapPatternsToChartTime';

/**
 * Same gap-compressed map used by the pattern-mapping spec:
 *   compressed → real     100→1000, 200→1100, 300→5000 (a collapsed gap).
 * The trade overlay feeds epoch-MS times through this resolver, so it must land
 * on the identical compressed times markers do.
 */
const realTimeMap = new Map<number, number>([
  [100, 1000],
  [200, 1100],
  [300, 5000],
]);

describe('buildChartTimeResolver', () => {
  const resolver = buildChartTimeResolver(realTimeMap);

  it('maps an in-window epoch-ms time to its compressed time', () => {
    expect(resolver.resolveMs(1_100_000)).toBe(200);
  });

  it('maps a post-gap bar whose compressed time diverges from real', () => {
    expect(resolver.resolveMs(5_000_000)).toBe(300);
  });

  it('resolves a time that falls INSIDE a bar (not exactly at its start)', () => {
    // 1150s is 50s into the 1100 bar (< 100s width) → compressed 200.
    expect(resolver.resolveMs(1_150_000)).toBe(200);
  });

  it('returns null for a time outside the displayed window', () => {
    expect(resolver.resolveMs(9_999_000)).toBeNull();
  });
});
