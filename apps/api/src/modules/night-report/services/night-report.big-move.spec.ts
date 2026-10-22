import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { NightReportStore, TrackerRow } from '../repositories/night-report.repository';
import type { BigMoveWatchSource } from '../../stock-move/stock-move.service';
import { NightReportService, type MoodSource, type ScorecardSource } from './night-report.service';

const NOW = new Date('2026-10-21T02:30:00Z');
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const tracker = (id: string, symbol: string, exchange: string, kind = 'POSITION'): TrackerRow => ({
  id, symbol, exchange, token: '', kind, qty: 1, entryPrice: 1, lastLtp: null, pnl: null, pnlPercent: null,
});
const store: NightReportStore = {
  openTrackers: async () => [
    tracker('t1', 'KEI27OCT264000CE', 'NFO'),
    tracker('t2', 'RELIANCE-EQ', 'NSE', 'HOLDING'),
    tracker('t3', 'NIFTY28OCT2625000CE', 'NFO'),
    tracker('t4', 'CRUDEOIL19NOV26FUT', 'MCX'),
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
  mbmChainCaptures: async () => [],
  mbmPredictionsBetween: async () => [],
  lastOvernightReviewAt: async () => null,
};
const mood: MoodSource = { behaviour: async () => ({ status: 'absent' }) };
const scorecards = {
  forTrackers: async () => new Map(),
  newsIdeasSince: async () => [{ symbol: 'INFY' }],
} as unknown as ScorecardSource;

describe('NightReportService — bigMoveWatch section', () => {
  it('asks for the held stocks (no indices, no MCX) and the news-idea stocks, and carries the view', async () => {
    const view = { asOf: '2026-10-20', modelId: 'm1', scored: 210, rows: [] };
    const watch = jest.fn<ReturnType<BigMoveWatchSource['watch']>, Parameters<BigMoveWatchSource['watch']>>(async () => view);
    const r = await new NightReportService(store, mood, { clock, hold: [] }, scorecards, undefined, { watch }).build('u1', NOW);
    expect(watch).toHaveBeenCalledWith({ held: ['KEI', 'RELIANCE'], newsIdeas: ['INFY'] });
    expect(r.bigMoveWatch).toEqual(view);
  });

  it('fails soft into { error }; null when the stock-move module is not loaded', async () => {
    const r = await new NightReportService(store, mood, { clock, hold: [] }, undefined, undefined, {
      watch: async () => {
        throw new Error('relation "stock_move_scores" does not exist');
      },
    }).build('u1', NOW);
    expect(r.bigMoveWatch).toEqual({ error: 'relation "stock_move_scores" does not exist' });
    expect(Array.isArray(r.positions)).toBe(true);
    expect((await new NightReportService(store, mood, { clock, hold: [] }).build('u1', NOW)).bigMoveWatch).toBeNull();
  });
});
