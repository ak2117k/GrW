import {
  selectHitRate,
  toHitRate,
  SYMBOL_SCOPE_MIN_SAMPLE,
  type HitRateStats,
} from './zone-break-hit-rate';

const stats = (wins: number, sample: number): HitRateStats => ({ wins, sample });

describe('toHitRate', () => {
  it('computes a percentage and carries the sample and scope', () => {
    expect(toHitRate(stats(15, 30), 'symbol')).toEqual({ pct: 50, sample: 30, scope: 'symbol' });
  });

  it('rounds to one decimal', () => {
    // 1/3 = 33.333…%
    expect(toHitRate(stats(1, 3), 'cohort')).toEqual({ pct: 33.3, sample: 3, scope: 'cohort' });
  });

  it('an empty sample is null, not 0% — 0/0 is not a measurement', () => {
    expect(toHitRate(stats(0, 0), 'symbol')).toBeNull();
  });

  it('zero wins over a real sample IS 0% — a measured zero is a measurement', () => {
    expect(toHitRate(stats(0, 12), 'cohort')).toEqual({ pct: 0, sample: 12, scope: 'cohort' });
  });

  it('a missing tally is null', () => {
    expect(toHitRate(null, 'symbol')).toBeNull();
    expect(toHitRate(undefined, 'cohort')).toBeNull();
  });

  // wins > sample can only mean the two counts came from different snapshots.
  // Reporting 120% would be worse than reporting nothing.
  it('refuses an incoherent tally rather than emitting a >100% rate', () => {
    expect(toHitRate(stats(12, 10), 'symbol')).toBeNull();
    expect(toHitRate(stats(-1, 10), 'symbol')).toBeNull();
    expect(toHitRate(stats(NaN, 10), 'symbol')).toBeNull();
    expect(toHitRate(stats(1, Infinity), 'symbol')).toBeNull();
  });
});

describe('selectHitRate scoping', () => {
  it('uses the symbol when it has at least the minimum resolved sample', () => {
    const r = selectHitRate(stats(20, SYMBOL_SCOPE_MIN_SAMPLE), stats(5, 100));
    expect(r).toEqual({ pct: 66.7, sample: 30, scope: 'symbol' });
  });

  it('falls back to the cohort one observation below the threshold', () => {
    const r = selectHitRate(stats(20, SYMBOL_SCOPE_MIN_SAMPLE - 1), stats(50, 200));
    expect(r).toEqual({ pct: 25, sample: 200, scope: 'cohort' });
  });

  it('null when neither scope has any resolved history', () => {
    expect(selectHitRate(stats(0, 0), stats(0, 0))).toBeNull();
    expect(selectHitRate(null, null)).toBeNull();
  });

  it('null when the symbol is thin and there is no cohort at all', () => {
    expect(selectHitRate(stats(3, 5), null)).toBeNull();
  });

  it('reports the CHOSEN scope, never the other one', () => {
    // Symbol qualifies; the cohort's much larger sample must not leak into the
    // answer. A response that mixed a symbol pct with a cohort n would be a lie
    // about how much evidence exists.
    const r = selectHitRate(stats(30, 40), stats(1, 5000))!;
    expect(r.scope).toBe('symbol');
    expect(r.sample).toBe(40);
    expect(r.pct).toBe(75);
  });

  /**
   * The invariant the whole module exists for: a percentage is never reportable
   * without the sample behind it. Swept across every shape the selector can
   * return, including the boundary and the degenerate tallies.
   */
  it('never returns a pct without a sample size', () => {
    const cases: Array<[HitRateStats | null, HitRateStats | null]> = [
      [stats(0, 0), stats(0, 0)],
      [stats(1, 1), null],
      [stats(1, 1), stats(1, 2)],
      [stats(29, 29), stats(0, 0)],
      [stats(30, 30), stats(0, 0)],
      [stats(0, 31), stats(9, 9)],
      [null, stats(4, 8)],
      [stats(99, 10), stats(4, 8)],
    ];
    for (const [symbol, cohort] of cases) {
      const r = selectHitRate(symbol, cohort);
      if (r === null) continue;
      expect(typeof r.pct).toBe('number');
      expect(Number.isFinite(r.pct)).toBe(true);
      expect(typeof r.sample).toBe('number');
      expect(r.sample).toBeGreaterThan(0);
      expect(r.pct).toBeGreaterThanOrEqual(0);
      expect(r.pct).toBeLessThanOrEqual(100);
      expect(['symbol', 'cohort']).toContain(r.scope);
    }
  });

  // No prior, no default, no smoothing. An unmeasured projection says so.
  it('never substitutes a default when there is no history', () => {
    const r = selectHitRate(stats(0, 0), stats(0, 0));
    expect(r).toBeNull();
    expect(r).not.toEqual(expect.objectContaining({ pct: 50 }));
  });
});
