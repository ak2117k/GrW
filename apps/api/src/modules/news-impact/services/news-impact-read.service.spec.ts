import { digestOrder, NewsImpactReadService, reactionSoFar } from './news-impact-read.service';

const imp = (id: string, magnitude: string, rank: number, o: Record<string, unknown> = {}) => ({
  id, clusterId: `c-${id}`, analysedAt: new Date('2026-10-23T06:00:00Z'), direction: 'BULL', magnitude, horizon: 'DAYS', symbols: ['TCS'], sectors: [],
  indexName: null, pricedIn: false, confidence: 0.8, oneLine: `line ${id}`, rank, alertedAt: null,
  cluster: { headline: `H ${id}`, sources: ['Economic Times'], sourceCount: 2, firstSeen: new Date('2026-10-23T05:00:00Z'), lastSeen: new Date(), materialType: 'NEWS', relevance: 0.8, articleIds: [`a-${id}`], instruments: ['TCS'] },
  ...o,
});

describe('news-impact reads', () => {
  it('reaction so far = the latest filled point vs p0', () => {
    expect(reactionSoFar({ symbol: 'TCS', p0: 100, p15: 101, p60: 102, pClose: null, pNextClose: null })).toEqual({ symbol: 'TCS', movePct: 2, at: 'p60' });
    expect(reactionSoFar({ symbol: 'TCS', p0: null, p15: 101, p60: null, pClose: null, pNextClose: null }).movePct).toBeNull();
  });

  it('digest: HIGH before MED before LOW, then rank; top 10', async () => {
    const rows = [imp('a', 'LOW', 9), imp('b', 'HIGH', 0.1), imp('c', 'MED', 5), ...Array.from({ length: 12 }, (_, i) => imp(`m${i}`, 'MED', i / 100))];
    expect([...rows].sort(digestOrder).map((r) => r.id).slice(0, 2)).toEqual(['b', 'c']);
    const repo = { impactsBetween: jest.fn(async () => rows), reactionsForClusters: jest.fn(async () => []) };
    const svc = new NewsImpactReadService(repo as never, {} as never);
    const d = await svc.digest(new Date(0), new Date(), 10);
    expect(d.items).toHaveLength(10);
    expect(d.items[0]).toMatchObject({ headline: 'H b', magnitude: 'HIGH', sources: ['Economic Times'], reaction: [] });
  });

  it('ideas feed: MED/HIGH non-neutral, not priced in, strength 0.75 / 1.0 with the sign', async () => {
    const rows = [imp('h', 'HIGH', 2, { direction: 'BEAR' }), imp('m', 'MED', 1), imp('l', 'LOW', 3), imp('p', 'HIGH', 4, { pricedIn: true }), imp('n', 'HIGH', 5, { direction: 'NEUTRAL' })];
    const repo = { impactsBetween: jest.fn(async () => rows) };
    const prisma = { newsArticle: { findMany: jest.fn(async () => [{ id: 'a-h', url: 'u1', source: 'ET', publishedAt: new Date() }, { id: 'a-m', url: 'u2', source: 'ET', publishedAt: new Date() }]) } };
    const out = await new NewsImpactReadService(repo as never, prisma as never).rankedArticles(new Date(0), new Date(), 10);
    expect(out.map((a) => [a.id, a.sentimentScore])).toEqual([['a-h', -1], ['a-m', 0.75]]);
    expect(out[0].instruments).toEqual(['TCS']);
  });
});
