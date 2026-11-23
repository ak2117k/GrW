/**
 * Every reader of news_articles honours `filtered` (NEWS_FILTER=on) and issues exactly today's query
 * otherwise; the ingesters store every row but never push a hidden one to the index / news-wake.
 */
import { of } from 'rxjs';
import { NewsAggregatorService } from '../../news/services/news-aggregator.service';
import { NseAnnouncementsService } from '../ingest/nse-announcements.service';
import { RetagService } from '../ingest/retag.service';
import { NewsIndexService } from '../index/news-index.service';
import { NewsImpactRepository } from '../../news-impact/news-impact.repository';
import { NightReportRepository } from '../../night-report/repositories/night-report.repository';
import { ScorecardRepository } from '../../overnight-scorecard/scorecard.repository';
import { VerificationSourcesRepository } from '../../self-review/repositories/verification-sources.repository';
import { SourceHealthBook } from '../source-health';
import { parseNewsEventsConfig } from '../config';
import { NewsRelevanceService } from './news-relevance.service';

const NOW = new Date('2026-11-23T05:00:00.000Z');
const saved = process.env.NEWS_FILTER;
const setMode = (m: string | undefined) => {
  if (m === undefined) delete process.env.NEWS_FILTER;
  else process.env.NEWS_FILTER = m;
};
afterEach(() => setMode(saved));

/** A prisma fake whose every model records the `where` of each call. */
function recordingPrisma(rows: unknown[] = []) {
  const calls: Array<{ model: string; op: string; where: unknown }> = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) =>
          jest.fn(async (args: { where?: unknown } = {}) => {
            calls.push({ model: name, op, where: args.where });
            if (op === 'count') return 0;
            if (op === 'aggregate') return { _max: {} };
            return name === 'newsArticle' && op === 'findMany' ? rows : [];
          }),
      },
    );
  const prisma = new Proxy({}, { get: (_t, name: string) => model(name) }) as Record<string, unknown>;
  const newsWheres = () => calls.filter((c) => c.model === 'newsArticle').map((c) => c.where);
  return { prisma, calls, newsWheres };
}

function relevance(env: Record<string, string>, fno = ['SBIN']) {
  const prisma = {
    instrument: { findMany: jest.fn(async () => fno.map((name) => ({ name }))) },
    tradeTracker: { findMany: jest.fn(async () => []) },
  };
  const svc = new NewsRelevanceService(prisma as never);
  svc.env = env;
  return svc;
}

describe('readers', () => {
  const readers: Array<[string, (p: Record<string, unknown>) => Promise<unknown>]> = [
    ['NewsAggregatorService.getNews', (p) => new NewsAggregatorService(p as never, {} as never, {} as never).getNews({})],
    ['NewsAggregatorService.getNewsForSymbol', (p) => new NewsAggregatorService(p as never, {} as never, {} as never).getNewsForSymbol('SBIN')],
    ['NewsAggregatorService.getNewsForStockPage', (p) => new NewsAggregatorService(p as never, {} as never, {} as never).getNewsForStockPage('SBIN')],
    ['NewsImpactRepository.unclusteredArticles', (p) => new NewsImpactRepository(p as never).unclusteredArticles(NOW, 10)],
    ['NewsImpactRepository.clusterTexts', (p) => new NewsImpactRepository(p as never).clusterTexts([{ id: 'c1' }])],
    ['NightReportRepository.newsPublishedBetween', (p) => new NightReportRepository(p as never).newsPublishedBetween(NOW, NOW, 10)],
    ['ScorecardRepository.newsBetween', (p) => new ScorecardRepository(p as never).newsBetween(NOW, NOW)],
    ['VerificationSourcesRepository.moveEvidence', (p) => new VerificationSourcesRepository(p as never).moveEvidence(['SBIN'], '2026-11-23', NOW, NOW)],
  ];

  it.each(readers)('%s: on → filtered:false in the where', async (_name, read) => {
    setMode('on');
    const { prisma, newsWheres } = recordingPrisma();
    await read(prisma);
    const ws = newsWheres();
    expect(ws.length).toBeGreaterThan(0);
    for (const w of ws) expect(w).toMatchObject({ filtered: false });
  });

  it.each(readers)('%s: observe / off → the query has no filtered key (as today)', async (_name, read) => {
    for (const m of ['observe', 'off', undefined]) {
      setMode(m);
      const { prisma, newsWheres } = recordingPrisma();
      await read(prisma);
      for (const w of newsWheres()) expect(w).not.toHaveProperty('filtered');
    }
  });

  it('getNews includeFiltered=true (audit) returns hidden rows even when on', async () => {
    setMode('on');
    const { prisma, newsWheres } = recordingPrisma();
    await new NewsAggregatorService(prisma as never, {} as never, {} as never).getNews({ includeFiltered: true });
    for (const w of newsWheres()) expect(w).not.toHaveProperty('filtered');
  });

  it('news index: rebuild and delta poll skip hidden rows when on', async () => {
    setMode('on');
    const { prisma, newsWheres } = recordingPrisma();
    const idx = new NewsIndexService(prisma as never, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' }), { subscribe: () => () => undefined, publish: jest.fn() }, new SourceHealthBook(), { sectorOf: () => null } as never);
    await idx.rebuild();
    await idx.poll();
    const ws = newsWheres();
    expect(ws).toHaveLength(2);
    for (const w of ws) expect(w).toMatchObject({ filtered: false });
  });
});

describe('ingesters store every row but never publish a hidden one', () => {
  const rss = (items: string) => `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
  const item = (title: string, link: string) => `<item><title>${title}</title><link>${link}</link><pubDate>Mon, 23 Nov 2026 04:00:00 GMT</pubDate></item>`;
  const FEED = rss(item('5 Best American Stocks to Buy for 2027 - Yahoo Finance', 'https://a.test/1') + item('Nifty ends higher on bank rally', 'https://a.test/2'));

  function aggregator(v2: string, rel: NewsRelevanceService | undefined) {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      newsArticle: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: `id${created.length}`, fetchedAt: NOW, filtered: false, ...data };
        }),
      },
    };
    const http = { get: jest.fn(() => of({ data: FEED })) };
    const sentiment = { analyzeSentiment: jest.fn().mockResolvedValue({ sentiment: 'neutral', score: 0, relatedSymbols: [] }) };
    const tagger = { tag: jest.fn().mockResolvedValue({ tags: { instruments: [], sectors: [], indices: [], markets: ['GLOBAL'] }, version: 1 }) };
    const bus = { publish: jest.fn(), subscribe: jest.fn() };
    const svc = new NewsAggregatorService(
      prisma as never, http as never, sentiment as never, new SourceHealthBook(), parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: v2 }), tagger as never, bus, rel,
    );
    svc.sourcesForTest = [{ name: 'Google News US Macro', url: 'https://a.test/rss', category: 'global' }];
    svc.clock = () => NOW;
    return { svc, created, bus };
  }

  it('RSS off: the insert is byte-for-byte the no-filter insert', async () => {
    const without = aggregator('true', undefined);
    await without.svc.fetchAllNews();
    const off = aggregator('true', relevance({ NEWS_FILTER: 'off' }));
    await off.svc.fetchAllNews();
    expect(off.created).toEqual(without.created);
    expect(off.bus.publish).toHaveBeenCalledTimes(2);
    const legacy = aggregator('false', relevance({ NEWS_FILTER: 'off' }));
    await legacy.svc.fetchAllNews();
    expect(Object.keys(legacy.created[0]).sort()).toEqual(
      ['category', 'publishedAt', 'relatedSymbols', 'sentiment', 'sentimentScore', 'source', 'summary', 'title', 'url'].sort(),
    );
  });

  it('RSS observe: both stored and published; the listicle carries its would-be reason, filtered untouched', async () => {
    const { svc, created, bus } = aggregator('true', relevance({ NEWS_FILTER: 'observe' }));
    await expect(svc.fetchAllNews()).resolves.toBe(2);
    expect(created.map((c) => [c.filtered, c.filterReason])).toEqual([[undefined, 'listicle'], [undefined, null]]);
    expect(bus.publish).toHaveBeenCalledTimes(2);
  });

  it('RSS on: both stored, the listicle hidden and NOT published', async () => {
    const { svc, created, bus } = aggregator('true', relevance({ NEWS_FILTER: 'on' }));
    await expect(svc.fetchAllNews()).resolves.toBe(2);
    expect(created.map((c) => [c.title, c.filtered, c.filterReason])).toEqual([
      ['5 Best American Stocks to Buy for 2027 - Yahoo Finance', true, 'listicle'],
      ['Nifty ends higher on bank rally', false, null],
    ]);
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish.mock.calls[0][0][0].title).toBe('Nifty ends higher on bank rally');
  });

  it('NSE on: a filing outside the universe is stored hidden and not published; a universe filing is', async () => {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      newsArticle: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: `n${created.length}`, fetchedAt: NOW, filtered: false, ...data };
        }),
      },
    };
    const rows = [
      { symbol: 'SBIN', desc: 'Outcome of Board Meeting', attchmntFile: 'https://x/1.pdf', an_dt: '23-Nov-2026 10:05:12', attchmntText: 'SBI results' },
      { symbol: 'TINYCO', desc: 'Outcome of Board Meeting', attchmntFile: 'https://x/2.pdf', an_dt: '23-Nov-2026 10:06:12', attchmntText: 'Tiny results' },
    ];
    const tagger = { tag: jest.fn(async ({ forceInstrument }: { forceInstrument: string }) => ({ tags: { instruments: [forceInstrument], sectors: [], indices: [], markets: [] }, version: 1 })) };
    const bus = { publish: jest.fn() };
    const svc = new NseAnnouncementsService(
      parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' }), { getJson: jest.fn().mockResolvedValue(rows) } as never, prisma as never, tagger as never,
      { analyzeSentiment: jest.fn().mockResolvedValue({ sentiment: 'neutral', score: 0 }) } as never, bus as never, new SourceHealthBook(), relevance({ NEWS_FILTER: 'on' }),
    );
    await expect(svc.runOnce(NOW)).resolves.toBe(2);
    expect(created.map((c) => [c.instruments, c.filtered, c.filterReason])).toEqual([
      [['SBIN'], false, null],
      [['TINYCO'], true, 'nse_not_in_universe'],
    ]);
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish.mock.calls[0][0][0].tags.instruments).toEqual(['SBIN']);
  });

  it('re-tag: a hidden row is re-tagged but not republished', async () => {
    const row = (id: string, filtered: boolean) => ({ id, title: 't', summary: '', source: 'ET', category: 'company', sentiment: null, publishedAt: NOW, fetchedAt: NOW, dateInferred: false, filtered });
    const rows = [row('a', false), row('b', true)];
    const prisma = {
      newsArticle: {
        findMany: jest.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ ...rows.find((r) => r.id === where.id)!, ...data })),
      },
    };
    const tagger = { ready: true, tag: jest.fn().mockResolvedValue({ tags: { instruments: ['X'], sectors: [], indices: [], markets: [] }, version: 1 }) };
    const bus = { publish: jest.fn() };
    await new RetagService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' }), prisma as never, tagger as never, bus as never).run(NOW);
    expect(prisma.newsArticle.update).toHaveBeenCalledTimes(2);
    expect(bus.publish.mock.calls[0][0].map((a: { id: string }) => a.id)).toEqual(['a']);
  });
});
