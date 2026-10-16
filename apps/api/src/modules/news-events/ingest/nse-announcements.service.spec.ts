import { NseAnnouncementsService } from './nse-announcements.service';
import { SourceHealthBook } from '../source-health';
import { parseNewsEventsConfig } from '../config';

const row = { symbol: 'SBIN', desc: 'Press Release', attchmntFile: 'https://nsearchives.nseindia.com/corporate/s.pdf', an_dt: '16-Oct-2026 10:05:12', attchmntText: 'SBI raises funds' };

function harness(getJson: jest.Mock, existing: string[] = [], mode = 'observe') {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    newsArticle: {
      findMany: jest.fn().mockResolvedValue(existing.map((url) => ({ url }))),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'n1', fetchedAt: new Date(), ...data };
      }),
    },
  };
  const tagger = { tag: jest.fn().mockResolvedValue({ tags: { instruments: ['SBIN'], sectors: ['NIFTY PSU BANK'], indices: [], markets: [] }, version: 1 }) };
  const sentiment = { analyzeSentiment: jest.fn().mockResolvedValue({ sentiment: 'bullish', score: 0.4, relatedSymbols: ['SBIN', 'GOLD'] }) };
  const bus = { publish: jest.fn() };
  const health = new SourceHealthBook();
  const svc = new NseAnnouncementsService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode }), { getJson } as never, prisma as never, tagger as never, sentiment as never, bus as never, health);
  return { svc, created, tagger, bus, health, prisma };
}

it('new announcements are saved with relatedSymbols [] (legacy readers unaffected), v2 tags forced to the symbol, and published', async () => {
  const { svc, created, tagger, bus, health } = harness(jest.fn().mockResolvedValue([row]));
  await expect(svc.runOnce(new Date('2026-10-16T05:00:00Z'))).resolves.toBe(1);
  expect(tagger.tag).toHaveBeenCalledWith(expect.objectContaining({ forceInstrument: 'SBIN', source: 'NSE Announcements', category: 'company' }));
  expect(created[0]).toMatchObject({ source: 'NSE Announcements', category: 'company', relatedSymbols: [], instruments: ['SBIN'], sentiment: 'bullish', tagVersion: 1 });
  expect(bus.publish).toHaveBeenCalledTimes(1);
  expect(health.all()[0]).toMatchObject({ source: 'NSE Announcements', consecutiveFailures: 0, itemsLastFetch: 1 });
});

it('already-stored urls are skipped', async () => {
  const { svc, created } = harness(jest.fn().mockResolvedValue([row]), [row.attchmntFile]);
  await expect(svc.runOnce(new Date())).resolves.toBe(0);
  expect(created).toHaveLength(0);
});

it('an NSE failure is a source failure, not an empty fetch', async () => {
  const { svc, health } = harness(jest.fn().mockRejectedValue(new Error('NSE corporate-announcements: response was not JSON (<html>…)')));
  await expect(svc.runOnce(new Date())).resolves.toBe(0);
  expect(health.all()[0]).toMatchObject({ source: 'NSE Announcements', consecutiveFailures: 1, lastError: expect.stringMatching(/not JSON/) });
});

it('a 200 that is not an announcements list is a source failure too', async () => {
  const { svc, health } = harness(jest.fn().mockResolvedValue({ error: 'blocked' }));
  await expect(svc.runOnce(new Date())).resolves.toBe(0);
  expect(health.all()[0]).toMatchObject({ consecutiveFailures: 1, lastError: expect.stringMatching(/not an announcements list/) });
});

it('flag false: the cron tick never calls NSE', async () => {
  const getJson = jest.fn();
  const { svc } = harness(getJson, [], 'false');
  await svc.tick();
  expect(getJson).not.toHaveBeenCalled();
});
