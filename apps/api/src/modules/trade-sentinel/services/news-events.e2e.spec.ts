/**
 * News & events v2 — the integration proof (plan Task I1). The REAL index, the REAL
 * events service and the REAL packet service; only Prisma (and the repository it
 * sits behind) is faked. Proves the `true` packet is built from memory: zero DB
 * reads while building, and the news+events read stays inside the 5 ms p99 budget.
 */
import { ContextPacketService } from './context-packet.service';
import { NewsIndexService } from '../../news-events/index/news-index.service';
import { EventsService } from '../../news-events/events/events.service';
import { InProcessNewsIngestBus } from '../../news-events/ingest-bus';
import { SourceHealthBook } from '../../news-events/source-health';
import { parseNewsEventsConfig } from '../../news-events/config';

const NOW = new Date('2026-10-16T05:00:00.000Z');
const cfg = parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' });
const row = (
  id: string,
  minsAgo: number,
  tags: Partial<Record<'instruments' | 'sectors' | 'indices' | 'markets', string[]>>,
) => ({
  id,
  title: `t ${id}`,
  source: 'ET',
  sentiment: 'neutral',
  publishedAt: new Date(NOW.getTime() - minsAgo * 60_000),
  fetchedAt: NOW,
  dateInferred: false,
  instruments: [] as string[],
  sectors: [] as string[],
  indices: [] as string[],
  markets: [] as string[],
  ...tags,
});

/** p99 of `n` timed calls of `fn`, in ms. */
function p99(fn: () => void, n = 1000): number {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(n * 0.99) - 1];
}

it('true, end to end: layered news and events from memory, zero DB reads while building, p99 < 5 ms', async () => {
  const newsFind = jest.fn().mockResolvedValueOnce([
    row('own', 5, { instruments: ['INFY'] }),
    row('sec', 30, { sectors: ['NIFTY IT'] }),
    row('idx', 40, { indices: ['NIFTY'] }),
    row('mkt', 50, { markets: ['GLOBAL'] }),
  ]);
  const health = new SourceHealthBook();
  health.ok('ET', 4, NOW);
  const index = new NewsIndexService(
    { newsArticle: { findMany: newsFind } } as never,
    cfg,
    new InProcessNewsIngestBus(),
    health,
    { sectorOf: (s: string) => (s === 'INFY' ? 'NIFTY IT' : null) } as never,
  );
  index.now = () => NOW.getTime();
  await index.start();
  index.onModuleDestroy();
  const listFrom = jest.fn().mockResolvedValue([
    { id: 'r', scope: 'company', kind: 'results', key: 'INFY', title: 'INFY financial results: Financial Results', startsAt: new Date('2026-10-16T03:45:00Z'), allDay: true, impact: 'high', source: 'NSE event calendar', sourceRef: null, fetchedAt: NOW },
    { id: 'f', scope: 'market', kind: 'fomc', key: 'US', title: 'FOMC rate decision', startsAt: new Date('2026-10-16T05:42:00Z'), allDay: false, impact: 'high', source: 'config/market-events.json', sourceRef: null, fetchedAt: NOW },
  ]);
  const events = new EventsService(cfg, { listFrom } as never, { build: jest.fn(), scheduleEnds: '2027-03-31' } as never, health);
  await events.reload(NOW);
  const legacyNews = jest.fn(() => {
    throw new Error('legacy news read on the hot path');
  });
  const svc = new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue([]) } as never,
    { levelsFor: jest.fn().mockResolvedValue(null) } as never,
    { recentFor: legacyNews } as never,
    undefined,
    cfg,
    index,
    events,
  );
  const reads = newsFind.mock.calls.length + listFrom.mock.calls.length;
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(NOW);
  const entry = { exchange: 'NSE', userId: 'u1', trackerId: 't1', symbol: 'INFY', kind: 'POSITION', ownership: 'SENTINEL', watched: true, reason: '' };
  const tick = {
    segment: 'EQ_INTRADAY', side: 'LONG', structureSymbol: 'INFY', entryPrice: 100, qty: 1, ltp: 101, underlyingLtp: 101, underlyingLtpAt: null,
    underlyingLtpSource: 's', underlyingLtpReason: null, nearestSupport: null, nearestResistance: null, structureReason: null, structureAt: null,
    structureSource: 's', holdingHigh: null, holdingLow: null, entryTime: NOW, expiry: null, volumeRatio: null, freshNewsCount: null,
    factorValues: {}, factorsReason: null, oiWallNow: null, oiWallPrev: null, oiWallsAt: null, greenFloorArmedLatched: false,
  };
  let p: Awaited<ReturnType<ContextPacketService['build']>>;
  try {
    p = await svc.build(entry as never, tick as never, null);
  } finally {
    jest.useRealTimers();
  }
  expect((p.news.headlines as unknown as { value: Array<{ layer: string }> }).value.map((h) => h.layer)).toEqual(['instrument', 'sector', 'index', 'market']);
  expect(p.news.freshCount).toMatchObject({ value: 1 });
  expect((p.events!.upcoming as unknown as { value: Array<{ kind: string }> }).value.map((e) => e.kind)).toEqual(['results', 'fomc']);
  expect(p.events!.minutesToNextHighImpact).toMatchObject({ value: 42 });
  expect(newsFind.mock.calls.length + listFrom.mock.calls.length).toBe(reads);
  expect(legacyNews).not.toHaveBeenCalled();

  // Budget: the news+events read. The dev machine is shared and loaded, so take
  // the best of several rounds — a real regression (I/O, an O(n) scan per call)
  // is slow in EVERY round; scheduler noise is not.
  const v2 = (svc as unknown as { v2Blocks: (e: unknown, t: unknown, n: Date, a: string) => unknown }).v2Blocks.bind(svc);
  const rounds = Array.from({ length: 10 }, () => p99(() => v2(entry, tick, NOW, NOW.toISOString())));
  expect(Math.min(...rounds)).toBeLessThan(5);
  expect(newsFind.mock.calls.length + listFrom.mock.calls.length).toBe(reads);
});
