import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { NewsRow, VerdictRow } from '../domain/night-report.logic';
import type { PositionRow } from '../domain/night-report.types';
import type { NightReportStore, TrackerRow } from '../repositories/night-report.repository';
import { NightReportService, type MoodSource } from './night-report.service';

const NOW = new Date('2026-10-20T02:30:00Z'); // 08:00 IST, Dussehra
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

const tracker = (over: Partial<TrackerRow>): TrackerRow => ({
  id: 't1', symbol: 'KEI27OCT264000CE', exchange: 'NFO', token: '55001', kind: 'POSITION', qty: 175,
  entryPrice: 120, lastLtp: 131.5, pnl: 2012.5, pnlPercent: 9.58, ...over,
});

const verdict = (over: Partial<VerdictRow>): VerdictRow => ({
  trackerId: 't1', verdict: 'EXIT_AT_OPEN', confidence: 'high',
  reason: 'OVERNIGHT RISK: results after close\nOPEN PLAN: exit in the first 5 minutes',
  invalidationPoint: 'KEI above 4100', triggeredBy: ['OVERNIGHT_REVIEW'], createdAt: new Date('2026-10-19T10:16:00Z'), ...over,
});

const article = (id: string, over: Partial<NewsRow>): NewsRow => ({
  id, title: `title ${id}`, summary: null, source: 'ET', url: `https://e/${id}`, category: 'company',
  sentiment: 'bullish', sentimentScore: 0.4, relatedSymbols: [], instruments: [], sectors: [], indices: [],
  markets: [], publishedAt: new Date('2026-10-19T14:00:00Z'), ...over,
});

function fakeStore(over: Partial<NightReportStore> = {}): NightReportStore & { calls: string[] } {
  const calls: string[] = [];
  const byUser: Record<string, TrackerRow[]> = {
    u1: [tracker({}), tracker({ id: 't2', symbol: 'RELIANCE-EQ', exchange: 'NSE', token: '2885', kind: 'HOLDING' })],
    u2: [tracker({ id: 'other', symbol: 'TCS-EQ', exchange: 'NSE', token: '11536' })],
  };
  return {
    calls,
    openTrackers: async (userId) => { calls.push(`trackers:${userId}`); return byUser[userId] ?? []; },
    cashTokens: async (names) => new Map(names.filter((n) => n === 'KEI').map((n) => [n, '13310'])),
    verdictsSince: async (userId, ids) => {
      calls.push(`verdicts:${userId}:${ids.join(',')}`);
      return userId === 'u1' ? [verdict({}), verdict({ trackerId: 't2', verdict: 'HOLD_OVERNIGHT', reason: 'OVERNIGHT RISK: none' })] : [];
    },
    newsPublishedBetween: async () => [
      article('a', { instruments: ['KEI'] }),
      article('b', { relatedSymbols: ['RELIANCE'] }),
      article('c', { markets: ['IN'], category: 'indian' }),
    ],
    eventsBetween: async () => [
      { id: 'e1', scope: 'company', kind: 'RESULTS', key: 'KEI', title: 'KEI Q2 results', startsAt: new Date('2026-10-20T10:00:00Z'), allDay: false, impact: 'high' },
      { id: 'e2', scope: 'market', kind: 'MACRO', key: 'US-CPI', title: 'US CPI', startsAt: new Date('2026-10-21T12:30:00Z'), allDay: false, impact: 'high' },
    ],
    dailySignalsOn: async () => [
      { instrument: 'NIFTY', signalDate: new Date('2026-10-19T00:00:00Z'), setup: 'BB_BREAKOUT_UP', action: 'LONG_SETUP', close: 25310.2, ret5dBp: null, ret10dBp: null, ret20dBp: null },
    ],
    newestNewsFetchedAt: async () => new Date('2026-10-20T02:20:00Z'),
    dailyCandles: async () => ({ newest: new Date('2026-10-18T18:30:00Z'), countAtDay: 212 }),
    newestMbmPredictionAt: async () => new Date('2026-10-19T09:55:00Z'),
    newestMbmChainAt: async () => null,
    lastOvernightReviewAt: async () => new Date('2026-10-19T10:16:00Z'),
    ...over,
  };
}

const mood: MoodSource = {
  behaviour: async () => ({ status: 'ok', asOf: '2026-10-19T10:00:00Z', horizons: { '30m': { p: 0.31, regime: 'QUIET', q25Bp: 8, q75Bp: 22 } } }),
};

const service = (store: NightReportStore, hold: string[] = ['RELIANCE-EQ']) => new NightReportService(store, mood, { clock, hold });
const ok = <T>(s: T | { error: string }): T => {
  if (s && typeof s === 'object' && 'error' in s) throw new Error(`section failed: ${(s as { error: string }).error}`);
  return s as T;
};

describe('NightReportService', () => {
  it('builds every section over the holiday night', async () => {
    const r = await service(fakeStore()).build('u1', NOW);
    expect(r.window).toMatchObject({ from: '2026-10-19T10:00:00.000Z', nextOpen: '2026-10-21T03:45:00.000Z' });

    const positions = ok(r.positions) as PositionRow[];
    expect(positions).toHaveLength(2);
    const [opt, cash] = positions;
    expect(opt.instrument.chartHref).toBe('/charts?symbol=KEI27OCT264000CE&token=55001&exchange=NFO');
    expect(opt.underlying).toEqual({ symbol: 'KEI', exchange: 'NSE', token: '13310', chartHref: '/charts?symbol=KEI&token=13310&exchange=NSE' });
    expect(opt.overnight).toMatchObject({ verdict: 'EXIT_AT_OPEN', risk: 'results after close', plan: 'exit in the first 5 minutes', invalidation: 'KEI above 4100' });
    expect(opt.held).toBe(false);
    expect(cash.underlying).toBeNull();
    expect(cash.held).toBe(true);
    // The tracker kind passes through: the web shelves HOLDINGs (not reviewed overnight) apart.
    expect(positions.map((p) => p.kind)).toEqual(['POSITION', 'HOLDING']);

    const news = ok(r.news);
    expect(news.onPositions.map((g) => g.symbol.symbol).sort()).toEqual(['KEI', 'RELIANCE-EQ']); // a cash group links to the held instrument itself
    expect(news.market.map((i) => i.id)).toEqual(['c']);

    const events = ok(r.events);
    expect(events.find((e) => e.id === 'e1')!.touchesPositions.map((s) => s.symbol)).toEqual(['KEI']);
    expect(events.find((e) => e.id === 'e2')!.touchesPositions).toEqual([]);

    expect(ok(r.dailySetups)[0]).toMatchObject({ signalDate: '2026-10-19', instrument: { symbol: 'NIFTY', token: '99926000' } });
    expect(ok(r.mood)).toMatchObject({ status: 'ok', horizons: { '30m': { p: 0.31 } } });

    const jobs = ok(r.jobs);
    expect(Object.fromEntries(jobs.map((j) => [j.name, j.status]))).toEqual({
      'News fetch': 'ok',
      'Daily candles': 'ok',
      'MBM predictions': 'ok',
      'MBM chain snapshots': 'missing',
      'Sentinel overnight review': 'ok',
    });

    expect(r.summary).toEqual({ positions: 2, exitAtOpen: 1, tighten: 0, held: 1, newsOnPositions: 2, eventsToday: 1 });
  });

  it('a failing section returns {error} and the rest still render', async () => {
    const store = fakeStore({
      newsPublishedBetween: async () => { throw new Error('relation "news_articles" does not exist'); },
      newestMbmChainAt: async () => { throw new Error('timeout'); },
    });
    const r = await service(store).build('u1', NOW);
    expect(r.news).toEqual({ error: 'relation "news_articles" does not exist' });
    expect(ok(r.positions)).toHaveLength(2);
    expect(ok(r.events)).toHaveLength(2);
    expect(r.summary.newsOnPositions).toBe(0);
    // One unreadable job is a row, not a failed section.
    expect(ok(r.jobs).find((j) => j.name === 'MBM chain snapshots')).toMatchObject({ status: 'missing', detail: 'read failed: timeout' });
  });

  it('a failing positions section still lets news render unmatched', async () => {
    const r = await service(fakeStore({ openTrackers: async () => { throw new Error('db down'); } })).build('u1', NOW);
    expect(r.positions).toEqual({ error: 'db down' });
    expect(ok(r.news).onPositions).toEqual([]);
    expect(r.summary.positions).toBe(0);
  });

  it('scopes positions and verdicts to the requesting user', async () => {
    const store = fakeStore();
    const r = await service(store).build('u2', NOW);
    expect((ok(r.positions) as PositionRow[]).map((p) => p.trackerId)).toEqual(['other']);
    expect(store.calls).toEqual(['trackers:u2', 'verdicts:u2:other']);
  });
});
