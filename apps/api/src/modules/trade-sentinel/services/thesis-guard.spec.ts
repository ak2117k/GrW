import { guardInferredThesis, thesisGuardEnabled } from './thesis-guard';

describe('guardInferredThesis (2026-11-04 LAURUSLABS: invalidation breached at birth)', () => {
  const laurus = { direction: 'LONG' as const, levelPrice: 2343.9, invalidation: 2343.9, reason: 'breakout above PDH 2343.9, cleared and held' };

  it('LONG invalidation 2343.9 with underlying 2310 at entry → invalidation null, discarded BREACHED_AT_ENTRY', () => {
    const g = guardInferredThesis(laurus, 2310);
    expect(g.invalidation).toBeNull();
    expect(g.discarded).toBe('BREACHED_AT_ENTRY');
    expect(g.reason.endsWith('(invalidation 2343.9 already breached at entry 2310, discarded)')).toBe(true);
    expect(g.reason.startsWith('breakout above PDH 2343.9')).toBe(true);
  });

  it('a level that is the same claim as the breached invalidation is discarded with it', () => {
    expect(guardInferredThesis(laurus, 2310).levelPrice).toBeNull();
    // a different level (a support well below) is kept
    expect(guardInferredThesis({ ...laurus, levelPrice: 2280 }, 2310).levelPrice).toBe(2280);
  });

  it('SHORT invalidation 100 with underlying 105 → discarded', () => {
    const g = guardInferredThesis({ direction: 'SHORT', levelPrice: 98, invalidation: 100, reason: 'rejection at 100' }, 105);
    expect(g).toMatchObject({ invalidation: null, discarded: 'BREACHED_AT_ENTRY', levelPrice: 98 });
  });

  it('equality counts as breached', () => {
    expect(guardInferredThesis({ ...laurus, invalidation: 2310 }, 2310).discarded).toBe('BREACHED_AT_ENTRY');
    expect(guardInferredThesis({ direction: 'SHORT', levelPrice: null, invalidation: 105, reason: 'x' }, 105).discarded).toBe('BREACHED_AT_ENTRY');
  });

  it('LONG invalidation 2290 with underlying 2310 → unchanged, discarded null', () => {
    const t = { direction: 'LONG' as const, levelPrice: 2300, invalidation: 2290, reason: 'holding 2300 support' };
    expect(guardInferredThesis(t, 2310)).toEqual({ levelPrice: 2300, invalidation: 2290, reason: t.reason, discarded: null });
  });

  it('keeps invalidation record-only when entry underlying unknown → invalidation unchanged, discarded ENTRY_UNKNOWN', () => {
    const g = guardInferredThesis(laurus, null);
    expect(g.invalidation).toBe(2343.9);
    expect(g.levelPrice).toBe(2343.9);
    expect(g.discarded).toBe('ENTRY_UNKNOWN');
    expect(g.reason).toMatch(/underlying at entry unknown/);
    expect(guardInferredThesis(laurus, Number.NaN).discarded).toBe('ENTRY_UNKNOWN');
  });

  it('no invalidation → nothing to guard', () => {
    const t = { direction: 'LONG' as const, levelPrice: null, invalidation: null, reason: 'r' };
    const none = { levelPrice: null, invalidation: null, reason: 'r', discarded: null };
    expect(guardInferredThesis(t, 2310)).toEqual(none);
    expect(guardInferredThesis(t, null)).toEqual(none);
  });

  it('THESIS_GUARD is on unless exactly "false"', () => {
    expect(thesisGuardEnabled({})).toBe(true);
    expect(thesisGuardEnabled({ THESIS_GUARD: 'off' })).toBe(true);
    expect(thesisGuardEnabled({ THESIS_GUARD: 'false' })).toBe(false);
  });
});
