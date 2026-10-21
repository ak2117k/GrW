import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { Scorecard } from '../../overnight-scorecard/scorecard.types';
import type { NewsIdeaItem, PositionRow } from '../domain/night-report.types';
import type { NightReportStore } from '../repositories/night-report.repository';
import { NightReportService, type MoodSource, type ScorecardSource } from './night-report.service';

const NOW = new Date('2026-10-20T02:30:00Z'); // 08:00 IST, Dussehra
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

const store: NightReportStore = {
  openTrackers: async () => [
    { id: 't1', symbol: 'RELIANCE28OCT261400CE', exchange: 'NFO', token: '1', kind: 'POSITION', qty: 500, entryPrice: 20, lastLtp: 18, pnl: -1000, pnlPercent: -10 },
    { id: 't2', symbol: 'TCS-EQ', exchange: 'NSE', token: '11536', kind: 'POSITION', qty: 10, entryPrice: 3000, lastLtp: 3010, pnl: 100, pnlPercent: 0.3 },
  ],
  cashTokens: async () => new Map(),
  verdictsSince: async () => [],
  newsPublishedBetween: async () => [],
  eventsBetween: async () => [],
  dailySignalsOn: async () => [],
  newestNewsFetchedAt: async () => null,
  dailyCandles: async () => ({ newest: null, countAtDay: 0 }),
  newestMbmPredictionAt: async () => null,
  newestMbmChainAt: async () => null,
  mbmPredictionsBetween: async () => [],
  lastOvernightReviewAt: async () => null,
};
const mood: MoodSource = { behaviour: async () => ({ status: 'absent' }) };

const card: Scorecard = {
  id: 'sc1', userId: 'u1', symbol: 'RELIANCE28OCT261400CE', exchange: 'NFO', underlying: 'RELIANCE', side: 'BULLISH',
  window: 'OVERNIGHT', computedAt: '2026-10-19T10:10:00.000Z',
  factors: [{ name: 'oi', points: 2, value: 'PCR 2.1', reason: 'bullish positioning', available: true }],
  total: 2, band: 'SUPPORTS',
};
const idea: NewsIdeaItem = {
  id: 'i1', createdAt: '2026-10-19T18:00:00.000Z', symbol: 'INFY', exchange: 'NSE', newsIds: ['n1'], headline: 'INFY wins deal',
  idea: 'CE_IDEA', rationale: 'r', invalidation: 'i', whatToDo: 'w', scorecardId: 'sc2', scorecard: null,
  nextOpen: null, nextClose: null, moveBp: null, filledAt: null, url: 'https://example.com/n1',
};

const ok = <T>(s: T | { error: string }): T => {
  if (s && typeof s === 'object' && 'error' in s) throw new Error(`section failed: ${(s as { error: string }).error}`);
  return s as T;
};

describe('NightReportService — scorecard additions', () => {
  it('attaches each position its scorecard (null when none) and lists news ideas since the close', async () => {
    let since: Date | null = null;
    const src: ScorecardSource = {
      forTrackers: async () => new Map([['t1', card]]),
      newsIdeasSince: async (s) => { since = s; return [idea]; },
    };
    const r = await new NightReportService(store, mood, { clock, hold: [] }, src).build('u1', NOW);
    const rows = ok(r.positions) as PositionRow[];
    expect(rows.find((p) => p.trackerId === 't1')?.scorecard).toEqual(card);
    expect(rows.find((p) => p.trackerId === 't2')?.scorecard).toBeNull();
    expect(ok(r.newsIdeas)).toEqual([idea]);
    expect(since!.toISOString()).toBe(r.window.from);
  });

  it('fails soft: a scorecard read error nulls the scorecards, a news-ideas error is only that section', async () => {
    const src: ScorecardSource = {
      forTrackers: async () => { throw new Error('scorecards down'); },
      newsIdeasSince: async () => { throw new Error('ideas down'); },
    };
    const r = await new NightReportService(store, mood, { clock, hold: [] }, src).build('u1', NOW);
    const rows = ok(r.positions) as PositionRow[];
    expect(rows).toHaveLength(2);
    expect(rows.every((p) => p.scorecard === null)).toBe(true);
    expect(r.newsIdeas).toEqual({ error: 'ideas down' });
  });

  it('without the scorecard module: scorecards null and an empty news-ideas list', async () => {
    const r = await new NightReportService(store, mood, { clock, hold: [] }).build('u1', NOW);
    expect((ok(r.positions) as PositionRow[]).every((p) => p.scorecard === null)).toBe(true);
    expect(ok(r.newsIdeas)).toEqual([]);
  });
});
