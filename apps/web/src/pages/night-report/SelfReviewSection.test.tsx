import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { NightReport } from '@/types/nightReport.types';
import type { SelfReviewLatest } from '@/types/selfReview.types';
import fixture from '../../../tests/fixtures/night-report.json';
import { NightReportView } from './NightReportView';
import { SelfReviewPanel } from './SelfReviewSection';
import { ProposalCard } from '../self-review/SelfReviewViews';

const latest: SelfReviewLatest = {
  run: {
    id: 'run1',
    sessionDate: '2026-10-20',
    startedAt: '2026-10-20T11:35:00Z',
    finishedAt: '2026-10-20T11:37:00Z',
    status: 'DONE',
    summary: null,
  },
  summary: {
    session: '2026-10-20',
    byKind: {
      SCORECARD_TOTAL: { n: 6, right: 4, wrong: 2, nullCount: 0, hitRate: 0.667 },
      OVERNIGHT_VERDICT: { n: 3, right: 1, wrong: 2, nullCount: 0, hitRate: 0.333 },
    },
  },
  misses: [
    { refIds: ['v1'], cause: 'Exited at open into a gap-up the OI build had flagged', kind: 'OVERNIGHT_VERDICT', symbol: 'NIFTY' },
    { refIds: ['v2'], cause: 'Second cause' },
    { refIds: ['v3'], cause: 'Third cause' },
    { refIds: ['v4'], cause: 'Fourth cause' },
  ],
  lessonsAdded: [
    { id: 'l1', key: 'oi-gap', text: 'Weigh a fresh put build before exiting at open.', scope: 'SENTINEL_OVERNIGHT', rightCount: 0, wrongCount: 0, status: 'ACTIVE', firstSeen: '', lastSeen: '' },
  ],
  proposalsPending: 2,
};

function html(node: ReactElement) {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe('SelfReviewPanel', () => {
  it('shows hits/misses per kind, top 3 misses, lessons added and the pending link', () => {
    const out = html(<SelfReviewPanel data={latest} />);
    expect(out).toContain('Session 20 Oct 2026');
    expect(out).toContain('Scorecard calls');
    expect(out).toContain('67% · 4 right / 2 wrong');
    expect(out).toContain('Overnight verdicts');
    expect(out).toContain('5 right · 4 wrong');
    expect(out).toContain('Exited at open into a gap-up');
    expect(out).toContain('Overnight verdicts · NIFTY');
    expect(out).toContain('Third cause');
    expect(out).not.toContain('Fourth cause');
    expect(out).toContain('Weigh a fresh put build before exiting at open.');
    expect(out).toContain('2 tuning proposals waiting for approval');
    expect(out).toContain('href="/self-review"');
  });

  it('says so when there is no run yet', () => {
    const out = html(<SelfReviewPanel data={{ run: null, summary: null, misses: [], lessonsAdded: 0, proposalsPending: 0 }} />);
    expect(out).toContain('No self-review run yet.');
  });
});

describe('NightReportView self-review section (fail-soft)', () => {
  const base = fixture as unknown as NightReport;
  it('absent → not in this build; error → section failed; present → panel', () => {
    expect(html(<NightReportView report={{ ...base, selfReview: undefined }} />)).toContain('The self-review is not in this API build yet.');
    const failed = html(<NightReportView report={{ ...base, selfReview: { error: 'boom' } }} />);
    expect(failed).toContain('aria-label="Self-review"');
    expect(failed).toContain('Couldn&#x27;t load this section');
    expect(html(<NightReportView report={{ ...base, selfReview: latest }} />)).toContain('data-testid="self-review-panel"');
  });
});

describe('ProposalCard', () => {
  it('shows target, current → proposed, rationale, evidence and buttons for a pending proposal', () => {
    const out = html(
      <ProposalCard
        p={{
          id: 'p1',
          key: 'news-weight-down',
          target: 'scorecard.factor.news.weight',
          currentValue: 1,
          proposedValue: 0.5,
          rationale: 'News factor rolling-20 hit rate 38%.',
          evidence: { n: 13, right: 5, wrong: 8, examples: [{ refId: 'r1', symbol: 'RELIANCE', sessionDate: '2026-10-17' }] },
          status: 'PENDING',
          createdAt: '2026-10-20T11:35:00Z',
          decidedAt: null,
          decidedBy: null,
        }}
        onDecide={() => {}}
      />,
    );
    expect(out).toContain('News factor weight');
    expect(out).toContain('>1<');
    expect(out).toContain('>0.5<');
    expect(out).toContain('News factor rolling-20 hit rate 38%.');
    expect(out).toContain('13 cases · 5 right / 8 wrong');
    expect(out).toContain('RELIANCE');
    expect(out).toContain('17 Oct 2026');
    expect(out).toContain('Approve');
    expect(out).toContain('Reject');
  });
});
