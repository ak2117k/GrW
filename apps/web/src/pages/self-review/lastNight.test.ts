import { describe, expect, it } from 'vitest';
import type { SelfReviewRun } from '@/types/selfReview.types';
import { dayLabel, findingMeta, istTime, nightStatuses, outcomeOf, outcomeTally, windowLine } from './lastNight';

const run = (sessionDate: string, over: Partial<SelfReviewRun> = {}): SelfReviewRun => ({
  id: `${sessionDate}-${over.status ?? 'DONE'}`, sessionDate, startedAt: '2026-11-09T19:00:00Z', finishedAt: '2026-11-09T19:04:00Z', status: 'DONE', summary: null, diagnosis: { misses: [1, 2] }, ...over,
});

describe('nightStatuses: recent weeknights, gaps said out loud', () => {
  // Wed 2026-11-11 18:00 IST
  const now = new Date('2026-11-11T12:30:00Z');
  it('lists weeknights newest first, skips weekends, and names a weeknight with no run (the 11-10 holiday)', () => {
    const runs = [run('2026-11-09'), run('2026-11-06', { diagnosis: null }), run('2026-11-05', { status: 'FAILED', diagnosis: null, error: 'AI CLI failed' })];
    const n = nightStatuses(runs, now, 5);
    expect(n.map((x) => x.session)).toEqual(['2026-11-10', '2026-11-09', '2026-11-06', '2026-11-05', '2026-11-04']);
    expect(n[0]).toMatchObject({ state: 'MISSING', text: 'No review ran for Tue 10 Nov (2026-11-10)', tone: 'bad' });
    expect(n[1]).toMatchObject({ state: 'REVIEWED', text: 'Mon 9 Nov: reviewed at 00:34 IST — 2 findings' });
    expect(n[2].state).toBe('NO_DIAGNOSIS');
    expect(n[3]).toMatchObject({ state: 'FAILED', text: 'Thu 5 Nov: review failed — AI CLI failed' });
    expect(n[4].state).toBe('MISSING');
  });
  it('a diagnosed run of the night wins over an undiagnosed later one', () => {
    const n = nightStatuses([run('2026-11-10', { diagnosis: null, id: 'late' }), run('2026-11-10')], now, 1);
    expect(n[0].state).toBe('REVIEWED');
  });
  it('before 03:00 IST the previous night is pending, not missing', () => {
    const early = new Date('2026-11-10T19:15:00Z'); // Wed 00:45 IST
    expect(nightStatuses([], early, 1)[0]).toMatchObject({ session: '2026-11-10', state: 'PENDING' });
  });
});

describe('findings formatting', () => {
  it('what it became, tally, meta line with ₹ or unknown', () => {
    const misses = [
      { refIds: ['a'], cause: 'c', outcome: { type: 'LESSON' as const, label: 'Lesson: k (active)' } },
      { refIds: ['b'], cause: 'c', outcome: { type: 'TICKET' as const, label: 'Fix ticket: T (OPEN)' } },
      { refIds: ['c'], cause: 'c', outcome: { type: 'ONE_OFF' as const, label: 'Recorded only — one-off' } },
      { refIds: ['d'], cause: 'c', causeType: 'NOISE' },
    ];
    expect(outcomeOf(misses[3]).label).toBe('Noise — no action');
    expect(outcomeTally(misses)).toBe('4 findings: 1 lesson, 1 fix ticket, 1 recorded only, 1 noise');
    expect(findingMeta({ refIds: ['x'], cause: 'c', symbol: 'GOLD', kind: 'DECISION:EXIT', category: 'TIMING', causeType: 'SETTING', costRupees: 29850 })).toBe(
      'GOLD · DECISION:EXIT · TIMING · SETTING · cost ₹29,850/lot',
    );
    expect(findingMeta({ refIds: ['x'], cause: 'c' })).toBe('₹ cost unknown');
    expect(istTime('2026-11-09T19:04:00Z')).toBe('00:34 IST');
    expect(dayLabel('2026-11-10')).toBe('Tue 10 Nov');
  });
  it('scorecard window line', () => {
    expect(windowLine({ sessions: 10, mistakes: 3, perSession: 0.3, costRupees: 4500, costUnknown: 1, costPerSession: 450 })).toBe('3 in 10 sessions (0.3/session) · ₹4,500 (+1 without ₹)');
    expect(windowLine({ sessions: 4, mistakes: 2, perSession: 0.5, costRupees: 0, costUnknown: 2, costPerSession: 0 })).toBe('2 in 4 sessions (0.5/session) · ₹ unknown');
    expect(windowLine({ sessions: 0, mistakes: 0, perSession: null, costRupees: 0, costUnknown: 0, costPerSession: null })).toBe('no reviewed sessions');
  });
});
