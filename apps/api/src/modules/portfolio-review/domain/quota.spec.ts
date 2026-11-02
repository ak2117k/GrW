import { FREE_REVIEWS_PER_MONTH, QUOTA_ENFORCED, istMonthStart, reviewQuotaFrom } from './quota';
import { acceptPlanExplanation } from './plan-prompt';

describe('reviewQuota hook (not enforced yet)', () => {
  const NOW = new Date('2026-11-02T08:00:00.000Z');
  it('1 free per month, counted but never blocking', () => {
    expect(FREE_REVIEWS_PER_MONTH).toBe(1);
    expect(QUOTA_ENFORCED).toBe(false);
    const q0 = reviewQuotaFrom(0, NOW);
    expect(q0).toMatchObject({ usedThisMonth: 0, freeLimit: 1, allowed: true, enforced: false, periodStart: '2026-11' });
    const q3 = reviewQuotaFrom(3, NOW);
    expect(q3.allowed).toBe(true);
    expect(q3.note).toMatch(/1 free review per month \(not enforced yet\) — 3 used/);
  });
  it('the IST month starts at 18:30 UTC on the last day of the previous month', () => {
    expect(istMonthStart(NOW).toISOString()).toBe('2026-10-31T18:30:00.000Z');
    // 2026-10-31 19:00 UTC is already 1 Nov in IST
    expect(reviewQuotaFrom(0, new Date('2026-10-31T19:00:00Z')).periodStart).toBe('2026-11');
  });
});

describe('acceptPlanExplanation', () => {
  it('rejects prediction / certainty wording, keeps hedged text', () => {
    expect(acceptPlanExplanation('Consider trimming RELIANCE; the rules suggest a stop at 1,380.')).toMatch(/Consider/);
    expect(acceptPlanExplanation('TCS will rise after results.')).toBeNull();
    expect(acceptPlanExplanation('This is risk-free.')).toBeNull();
    expect(acceptPlanExplanation('')).toBeNull();
  });
});
