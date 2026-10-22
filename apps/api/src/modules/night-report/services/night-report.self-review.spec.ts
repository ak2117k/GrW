import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { NightReportStore } from '../repositories/night-report.repository';
import { NightReportService, type MoodSource } from './night-report.service';

const NOW = new Date('2026-10-21T02:30:00Z');
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const store: NightReportStore = {
  openTrackers: async () => [],
  cashTokens: async () => new Map(),
  verdictsSince: async () => [],
  newsPublishedBetween: async () => [],
  eventsBetween: async () => [],
  dailySignalsOn: async () => [],
  newestNewsFetchedAt: async () => null,
  dailyCandles: async () => ({ newest: null, countAtDay: 0 }),
  newestMbmPredictionAt: async () => null,
  newestMbmChainAt: async () => null,
  mbmChainCaptures: async () => [],
  mbmPredictionsBetween: async () => [],
  lastOvernightReviewAt: async () => null,
};
const mood: MoodSource = { behaviour: async () => ({ status: 'absent' }) };

describe('NightReportService — selfReview section', () => {
  it('carries the latest self-review view as-is', async () => {
    const latest = { run: { id: 'r1' }, summary: null, misses: [], lessonsAdded: [], proposalsPending: 2 };
    const r = await new NightReportService(store, mood, { clock, hold: [] }, undefined, { latest: async () => latest }).build('u1', NOW);
    expect(r.selfReview).toEqual(latest);
  });

  it('fails soft into { error } and leaves the rest of the report intact', async () => {
    const r = await new NightReportService(store, mood, { clock, hold: [] }, undefined, {
      latest: async () => {
        throw new Error('relation "self_review_runs" does not exist');
      },
    }).build('u1', NOW);
    expect(r.selfReview).toEqual({ error: 'relation "self_review_runs" does not exist' });
    expect(r.positions).toEqual([]);
  });

  it('is null when the self-review module is not loaded', async () => {
    const r = await new NightReportService(store, mood, { clock, hold: [] }).build('u1', NOW);
    expect(r.selfReview).toBeNull();
  });
});
