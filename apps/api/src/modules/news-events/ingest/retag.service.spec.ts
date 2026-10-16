import { RetagService } from './retag.service';
import { parseNewsEventsConfig } from '../config';

it('re-tags rows of the last 48 h below TAG_VERSION, in pages, and republishes them', async () => {
  const now = new Date('2026-10-16T05:00:00Z');
  const row = (id: string) => ({ id, title: `t${id}`, summary: '', source: 'ET', category: 'company', sentiment: null, publishedAt: now, fetchedAt: now, dateInferred: false });
  const prisma = {
    newsArticle: {
      findMany: jest.fn().mockResolvedValueOnce([row('a'), row('b')]).mockResolvedValueOnce([]),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ ...row(where.id), ...data })),
    },
  };
  const tagger = { ready: true, tag: jest.fn().mockResolvedValue({ tags: { instruments: ['X'], sectors: [], indices: [], markets: [] }, version: 1 }) };
  const bus = { publish: jest.fn() };
  const svc = new RetagService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }), prisma as never, tagger as never, bus as never);
  await expect(svc.run(now)).resolves.toBe(2);
  expect(prisma.newsArticle.findMany.mock.calls[0][0].where).toEqual({
    publishedAt: { gte: new Date('2026-10-14T05:00:00Z') }, tagVersion: { lt: 1 },
  });
  expect(prisma.newsArticle.update).toHaveBeenCalledTimes(2);
  expect(bus.publish).toHaveBeenCalledTimes(1);
  expect(bus.publish.mock.calls[0][0].map((a: { id: string }) => a.id)).toEqual(['a', 'b']);
});

it('does nothing while the tagger has no aliases (it would only re-stamp version 0)', async () => {
  const prisma = { newsArticle: { findMany: jest.fn() } };
  const svc = new RetagService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' }), prisma as never, { ready: false } as never, { publish: jest.fn() } as never);
  await expect(svc.run(new Date())).resolves.toBe(0);
  expect(prisma.newsArticle.findMany).not.toHaveBeenCalled();
});

it('a row the tagger throws on is still stamped (untagged) so the loop terminates', async () => {
  const now = new Date('2026-10-16T05:00:00Z');
  const row = { id: 'a', title: 't', summary: null, source: 'ET', category: 'company', sentiment: null, publishedAt: now, fetchedAt: now, dateInferred: false };
  const prisma = {
    newsArticle: {
      findMany: jest.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    },
  };
  const tagger = { ready: true, tag: jest.fn().mockRejectedValue(new Error('boom')) };
  const svc = new RetagService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }), prisma as never, tagger as never, { publish: jest.fn() } as never);
  await expect(svc.run(now)).resolves.toBe(1);
  expect(prisma.newsArticle.update.mock.calls[0][0].data).toMatchObject({ instruments: [], tagVersion: 1 });
});

it('flag false: no boot work', () => {
  const prisma = { newsArticle: { findMany: jest.fn() } };
  const svc = new RetagService(parseNewsEventsConfig({}), prisma as never, { ready: true } as never, { publish: jest.fn() } as never);
  jest.useFakeTimers();
  try {
    svc.onApplicationBootstrap();
    jest.advanceTimersByTime(10_000);
  } finally {
    jest.useRealTimers();
  }
  expect(prisma.newsArticle.findMany).not.toHaveBeenCalled();
});
