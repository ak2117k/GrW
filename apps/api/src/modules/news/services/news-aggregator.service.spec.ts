import { of, throwError } from 'rxjs';
import { NewsAggregatorService, pubDateGuard, RSS_FETCH_TIMEOUT_MS } from './news-aggregator.service';
import { SourceHealthBook } from '../../news-events/source-health';
import { parseNewsEventsConfig } from '../../news-events/config';

const NOW = new Date('2026-10-16T05:00:00.000Z');
const rss = (items: string) => `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
const item = (title: string, link: string, pubDate?: string) =>
  `<item><title>${title}</title><link>${link}</link>${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}</item>`;

function harness(mode: string, bodies: Record<string, string | Error>) {
  const created: Array<Record<string, unknown>> = [];
  const http = {
    get: jest.fn((url: string, opts: { timeout: number; headers: Record<string, string> }) => {
      expect(opts.timeout).toBe(RSS_FETCH_TIMEOUT_MS);
      expect(opts.headers['User-Agent']).toMatch(/Mozilla/);
      const b = bodies[url];
      if (b === undefined) return throwError(() => new Error('timeout of 15000ms exceeded'));
      return b instanceof Error ? throwError(() => b) : of({ data: b });
    }),
  };
  const prisma = {
    newsArticle: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `id${created.length}`, fetchedAt: NOW, ...data };
      }),
    },
  };
  const sentiment = { analyzeSentiment: jest.fn().mockResolvedValue({ sentiment: 'neutral', score: 0, relatedSymbols: [] }) };
  const health = new SourceHealthBook();
  const tagger = { tag: jest.fn().mockResolvedValue({ tags: { instruments: ['GOLD'], sectors: ['MCX BULLION'], indices: [], markets: [] }, version: 1 }) };
  const bus = { publish: jest.fn(), subscribe: jest.fn() };
  const svc = new NewsAggregatorService(
    prisma as never, http as never, sentiment as never, health, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode }), tagger as never, bus,
  );
  svc.sourcesForTest = [
    { name: 'A', url: 'https://a.test/rss', category: 'indian' },
    { name: 'B', url: 'https://b.test/rss', category: 'global' },
  ];
  svc.clock = () => NOW;
  return { svc, created, health, tagger, bus };
}

describe('pubDateGuard', () => {
  it.each([
    [null, true],
    ['not a date', true],
    ['Thu, 16 Oct 2026 10:00:00', true], // no zone: cannot be placed in time
    ['Thu, 16 Oct 2026 12:00:00 +0530', true], // 1 h 30 min in the future
    ['Thu, 16 Oct 2026 10:35:00 +0530', false], // 5 min in the future: clock skew, tolerated
    ['Thu, 16 Oct 2026 04:00:00 GMT', false],
  ])('%j → dateInferred %s', (raw, inferred) => {
    const g = pubDateGuard(raw, NOW);
    expect(g.dateInferred).toBe(inferred);
    if (inferred) expect(g.publishedAt).toEqual(NOW);
  });
});

describe('NewsAggregatorService — M0', () => {
  it('a failing source is recorded, not silently quiet; the others still save', async () => {
    const { svc, created, health } = harness('false', { 'https://a.test/rss': rss(item('Nifty ends higher', 'https://a.test/1', 'Thu, 16 Oct 2026 04:00:00 GMT')) });
    await svc.fetchAllNews();
    expect(created).toHaveLength(1);
    expect(health.all().find((h) => h.source === 'B')).toMatchObject({ consecutiveFailures: 1, lastError: expect.stringMatching(/timeout/) });
    expect(health.all().find((h) => h.source === 'A')).toMatchObject({ consecutiveFailures: 0, itemsLastFetch: 1 });
  });

  it('flag false: the insert is exactly today\'s (no v2 keys)', async () => {
    const { svc, created } = harness('false', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1')) });
    await svc.fetchAllNews();
    expect(Object.keys(created[0]).sort()).toEqual(
      ['category', 'publishedAt', 'relatedSymbols', 'sentiment', 'sentimentScore', 'source', 'summary', 'title', 'url'].sort(),
    );
  });

  it('flag observe: a missing pubDate is stored as fetchedAt with dateInferred=true', async () => {
    const { svc, created } = harness('observe', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1')) });
    await svc.fetchAllNews();
    expect(created[0]).toMatchObject({ publishedAt: NOW, dateInferred: true });
  });

  it('flag observe: a CDATA-wrapped zoned pubDate is kept as published', async () => {
    const { svc, created } = harness('observe', {
      'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1', '<![CDATA[Fri, 16 Oct 2026 09:59:45 +0530]]>')),
    });
    await svc.fetchAllNews();
    expect(created[0]).toMatchObject({ publishedAt: new Date('2026-10-16T04:29:45.000Z'), dateInferred: false });
  });
});

describe('NewsAggregatorService — A5 tag once at ingestion', () => {
  it('observe: v2 columns written and the row is published once, right after its insert', async () => {
    const { svc, created, bus } = harness('observe', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1', 'Thu, 16 Oct 2026 04:00:00 GMT')) });
    await svc.fetchAllNews();
    expect(created[0]).toMatchObject({ instruments: ['GOLD'], sectors: ['MCX BULLION'], indices: [], markets: [], tagVersion: 1, dateInferred: false });
    expect(created[0].relatedSymbols).toEqual([]); // legacy tagging untouched (sentiment fake returns [])
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish.mock.calls[0][0][0]).toMatchObject({ id: 'id1', tags: { instruments: ['GOLD'] } });
  });

  it('false: the tagger and the bus are never touched', async () => {
    const { svc, tagger, bus } = harness('false', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1')) });
    await svc.fetchAllNews();
    expect(tagger.tag).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('a tagger failure still saves the article (untagged, tagVersion 0) and publishes it', async () => {
    const { svc, created, tagger, bus } = harness('observe', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1')) });
    tagger.tag.mockRejectedValueOnce(new Error('boom'));
    await svc.fetchAllNews();
    expect(created[0]).toMatchObject({ instruments: [], tagVersion: 0 });
    expect(bus.publish).toHaveBeenCalledTimes(1);
  });

  it('a failed insert (duplicate url) publishes nothing', async () => {
    const { svc, bus } = harness('observe', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1')) });
    (svc as unknown as { prisma: { newsArticle: { create: jest.Mock } } }).prisma.newsArticle.create.mockRejectedValueOnce(new Error('P2002'));
    await svc.fetchAllNews();
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
