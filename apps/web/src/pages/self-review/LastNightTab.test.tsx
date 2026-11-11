import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LessonScorecard, SelfReviewLatest } from '@/types/selfReview.types';
import { LastNightPanel } from './LastNightTab';
import { LessonScorecardPanel } from './LessonScorecard';
import { DEFAULT_TAB, tabFrom } from './SelfReviewPage';

const latest: SelfReviewLatest = {
  run: { id: 'r', sessionDate: '2026-11-09', startedAt: '2026-11-09T19:00:00Z', finishedAt: '2026-11-09T19:04:00Z', status: 'DONE', summary: null },
  summary: null,
  misses: [
    { refIds: ['dg:1'], cause: 'Orders blocked by the paper position count', symbol: 'GOLD', kind: 'DECISION:ENTRY_BLOCKED', category: 'OTHER', causeType: 'CODE_BUG', costRupees: 5500, outcome: { type: 'TICKET', label: 'Fix ticket: Live orders never placed (OPEN)' } },
    { refIds: ['v1'], cause: 'Exited on a NOISE read', category: 'TIMING', causeType: 'REASONING', costRupees: null, outcome: { type: 'ONE_OFF', label: 'Recorded only — one-off (needs 3 repeats in 10 sessions or ≥₹5,000)' } },
  ],
  lessonsAdded: [],
  proposalsPending: 0,
  engineAssessment: 'Engine took 2 trades, both paper winners.',
  exitNoiseAssessment: null,
  signalPaperAssessment: null,
};

describe('LastNightPanel (the default view)', () => {
  it('shows each finding with what it became, ₹ cost, assessments and the run line', () => {
    const html = renderToStaticMarkup(<LastNightPanel latest={latest} nights={[{ session: '2026-11-10', state: 'MISSING', text: 'No review ran for Tue 10 Nov (2026-11-10)', tone: 'bad' }]} />);
    expect(html).toContain('Last reviewed session · Mon 9 Nov');
    expect(html).toContain('Run DONE · started 00:30 IST · finished 00:34 IST');
    expect(html).toContain('2 findings: 1 fix ticket, 1 recorded only');
    expect(html).toContain('GOLD · DECISION:ENTRY_BLOCKED · OTHER · CODE_BUG · cost ₹5,500/lot');
    expect(html).toContain('→ Fix ticket: Live orders never placed (OPEN)');
    expect(html).toContain('Recorded only — one-off (needs 3 repeats in 10 sessions or ≥₹5,000)');
    expect(html).toContain('₹ cost unknown');
    expect(html).toContain('Engine took 2 trades');
    expect(html).toContain('No assessment this night.');
    expect(html).toContain('No review ran for Tue 10 Nov');
  });
  it('says so when nothing was found or nothing ran', () => {
    expect(renderToStaticMarkup(<LastNightPanel latest={{ ...latest, misses: [] }} nights={[]} />)).toContain('found nothing to flag');
    expect(renderToStaticMarkup(<LastNightPanel latest={null} nights={[]} />)).toContain('No review has run yet.');
  });
});

describe('tabs', () => {
  it('Last night is the default; ?tab= still selects the others', () => {
    expect(DEFAULT_TAB).toBe('last');
    expect(tabFrom(null)).toBe('last');
    expect(tabFrom('bogus')).toBe('last');
    expect(tabFrom('proposals')).toBe('proposals');
    expect(tabFrom('lessons')).toBe('lessons');
  });
});

describe('LessonScorecardPanel', () => {
  it('states the rule and shows before vs after per lesson', () => {
    const card: LessonScorecard = {
      rule: 'TOO_EARLY until 5 reviewed sessions since the lesson went active; then HELPING if its mistake happens at most half as often per reviewed session as before, otherwise NOT_HELPING.',
      reviewedSessions: 14,
      lessons: [
        {
          id: 'l1', key: 'hold-on-noise', text: 't', scope: 'SENTINEL_LIVE', status: 'ACTIVE', activeSince: '2026-11-03', rightCount: 3, wrongCount: 0, verdict: 'NOT_HELPING',
          before: { sessions: 8, mistakes: 4, perSession: 0.5, costRupees: 9000, costUnknown: 0, costPerSession: 1125 },
          after: { sessions: 6, mistakes: 3, perSession: 0.5, costRupees: 0, costUnknown: 3, costPerSession: 0 },
        },
      ],
    };
    const html = renderToStaticMarkup(<LessonScorecardPanel card={card} />);
    expect(html).toContain('TOO_EARLY until 5 reviewed sessions');
    expect(html).toContain('Counted over 14 reviewed sessions.');
    expect(html).toContain('hold-on-noise');
    expect(html).toContain('Not helping');
    expect(html).toContain('Active since Tue 3 Nov');
    expect(html).toContain('4 in 8 sessions (0.5/session) · ₹9,000');
    expect(html).toContain('3 in 6 sessions (0.5/session) · ₹ unknown');
  });
});
