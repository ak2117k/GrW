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
    mbmChainCaptures: async () => [],
    mbmPredictionsBetween: async (instrument, from, to) => {
      calls.push(`mbm:${instrument}:${from.toISOString()}:${to.toISOString()}`);
      return [
        { horizon: '30m', asOf: new Date('2026-10-19T04:00:00Z'), p: 0.7, regime: 'ACTIVE', q25Bp: 10, q50Bp: 20, q75Bp: 30, modelId: 'm1', featureSet: 'mbm-fs2', outcomeRangeBp: 25, outcomeBig: true },
        { horizon: '30m', asOf: new Date('2026-10-19T04:05:00Z'), p: 0.2, regime: 'QUIET', q25Bp: 5, q50Bp: 10, q75Bp: 15, modelId: 'm1', featureSet: 'mbm-fs2', outcomeRangeBp: 8, outcomeBig: false },
      ];
    },
    lastOvernightReviewAt: async () => new Date('2026-10-19T10:16:00Z'),
    ...over,
  };
}

const mood: MoodSource = {
  behaviour: async () => ({ status: 'ok', asOf: '2026-10-19T10:00:00Z', horizons: { '30m': { p: 0.31, regime: 'QUIET', q25Bp: 8, q75Bp: 22 } } }),
};

const service = (store: NightReportStore, hold: string[] = ['RELIANCE-EQ']) => new NightReportService(store, mood, { clock, hold });

describe('NightReportService mood: relative reading headline', () => {
  it('leads with points and the relative reading, keeps the 60-day call as the norm line', async () => {
    const rel: MoodSource = {
      behaviour: async () => ({
        status: 'ok', asOf: '2026-10-23T08:00:00Z', spot: 25_000,
        horizons: { '30m': { p: 0.97, regime: 'ACTIVE', q25Bp: 24, q50Bp: 32, q75Bp: 42, relRatio: 1.9, relLabel: 'MUCH_BUSIER', refRangeBp: 17 } },
      }),
    };
    const svc = new NightReportService(fakeStore(), rel, { clock, hold: [] });
    const m = ok((await svc.build('u1', NOW)).mood);
    expect(m.horizons['30m']).toMatchObject({
      headline: 'Next 30 min: ~80 pts (60–105) · much busier than recent days',
      norm: 'vs 60-day norm: BIG / ACTIVE p=0.97',
      relRatio: 1.9, relLabel: 'MUCH_BUSIER', refRangeBp: 17, q50Bp: 32,
    });
  });
});
const ok = <T>(s: T | { error: string }): T => {
  if (s && typeof s === 'object' && 'error' in s) throw new Error(`section failed: ${(s as { error: string }).error}`);
  return s as T;
};

describe('NightReportService', () => {
  it('builds every section over the holiday night', async () => {
    const store = fakeStore();
    const r = await service(store).build('u1', NOW);
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
    expect(ok(r.mood)).toMatchObject({
      status: 'ok',
      horizons: { '30m': { p: 0.31, headline: null, norm: 'vs 60-day norm: small / QUIET p=0.31', relLabel: null } },
    });

    // Model scorecard: 20 closed sessions read (Dussehra skipped), clipped to the model's first live session.
    const msc = ok(r.modelScorecard);
    expect(msc).toMatchObject({ instrument: 'NIFTY', lastSession: '2026-10-19', liveSince: '2026-10-19' });
    expect(msc.horizons['30m'].windows.map((w) => [w.requestedSessions, w.sessions, w.predictions, w.expected])).toEqual([
      [1, 1, 2, 75], [5, 1, 2, 75], [20, 1, 2, 75],
    ]);
    expect(msc.horizons['30m'].windows[0]).toMatchObject({ resolved: 2, hitRate: 1, baseRate: 0.5, auc: 1 });
    const mbmCall = store.calls.find((c) => c.startsWith('mbm:'))!;
    expect(mbmCall.endsWith(':2026-10-19T18:30:00.000Z')).toBe(true); // through the end of Mon 19 Oct IST

    const jobs = ok(r.jobs);
    expect(Object.fromEntries(jobs.map((j) => [j.name, j.status]))).toEqual({
      'News fetch': 'ok',
      'Daily candles': 'ok',
      'MBM predictions': 'ok',
      'MBM chain snapshots': 'missing',
      'Sentinel overnight review': 'ok',
    });

    expect(r.summary).toEqual({ positions: 1, exitAtOpen: 1, tighten: 0, held: 0, newsOnPositions: 2, eventsToday: 1 });
  });

  it('a failing section returns {error} and the rest still render', async () => {
    const store = fakeStore({
      newsPublishedBetween: async () => { throw new Error('relation "news_articles" does not exist'); },
      newestMbmChainAt: async () => { throw new Error('timeout'); },
      mbmPredictionsBetween: async () => { throw new Error('mbm_predictions unreadable'); },
    });
    const r = await service(store).build('u1', NOW);
    expect(r.news).toEqual({ error: 'relation "news_articles" does not exist' });
    expect(r.modelScorecard).toEqual({ error: 'mbm_predictions unreadable' });
    expect(ok(r.mood)).toMatchObject({ status: 'ok' });
    expect(ok(r.positions)).toHaveLength(2);
    expect(ok(r.events)).toHaveLength(2);
    expect(r.summary.newsOnPositions).toBe(0);
    // One unreadable job is a row, not a failed section.
    expect(ok(r.jobs).find((j) => j.name === 'MBM chain snapshots')).toMatchObject({ status: 'missing', detail: 'read failed: timeout' });
  });

  it('MBM chain snapshots: ok only with ≥90% of the 76 NIFTY ticks on the last session; a thin day is stale', async () => {
    const ranges: string[] = [];
    const job = async (ticks: number) => {
      const store = fakeStore({
        newestMbmChainAt: async () => new Date('2026-10-19T10:00:40Z'),
        mbmChainCaptures: async (from, to) => {
          ranges.push(`${from.toISOString()}|${to.toISOString()}`);
          return [{ instrument: 'BANKNIFTY', ticks: 76, rows: 152 }, { instrument: 'NIFTY', ticks, rows: ticks * 2 }];
        },
      });
      return ok((await service(store).build('u1', NOW)).jobs).find((j) => j.name === 'MBM chain snapshots')!;
    };
    const full = await job(76);
    expect(full).toMatchObject({ status: 'ok' });
    expect(full.detail).toBe('2026-10-19: BANKNIFTY 76/76 ticks (152 rows), NIFTY 76/76 ticks (152 rows); newest capture 2026-10-19T10:00:40.000Z');
    expect(ranges[0]).toBe('2026-10-18T18:30:00.000Z|2026-10-19T18:30:00.000Z');
    expect((await job(20)).status).toBe('stale');
    expect((await job(0)).status).toBe('stale'); // rows exist from earlier days only
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
    // The model scorecard read is market-wide (NIFTY), not per user.
    expect(store.calls.filter((c) => !c.startsWith('mbm:'))).toEqual(['trackers:u2', 'verdicts:u2:other']);
  });
});
