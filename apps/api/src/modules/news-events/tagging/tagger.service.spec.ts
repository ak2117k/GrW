import { NewsTaggerService } from './tagger.service';
import { parseNewsEventsConfig } from '../config';

const cfg = parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' });
const symbolIndex = { symbols: jest.fn().mockResolvedValue(new Set(['TATAMOTORS'])) };
const sectors = { sectorOf: () => null };

it('before aliases load: tickers/keywords only, version 0 (so the re-tag job fixes it later)', async () => {
  const s = new NewsTaggerService(cfg, symbolIndex as never, sectors as never, { instrument: { findMany: jest.fn().mockResolvedValue([]) } } as never);
  expect(s.ready).toBe(false);
  // The ticker rule still works; the company NAME cannot match yet.
  expect((await s.tag({ title: 'Tata Motors recalls cars', summary: '', source: 'ET', category: 'company' })).tags.instruments).toEqual([]);
  const r = await s.tag({ title: 'TATAMOTORS recalls cars', summary: '', source: 'ET', category: 'company' });
  expect(r).toEqual({ tags: expect.objectContaining({ instruments: ['TATAMOTORS'] }), version: 0 });
});

it('after rebuild: names match and the version is TAG_VERSION', async () => {
  const s = new NewsTaggerService(cfg, { symbols: jest.fn().mockResolvedValue(new Set()) } as never, sectors as never, { instrument: { findMany: jest.fn().mockResolvedValue([]) } } as never);
  s.rebuild([{ symbol: 'TATAMOTORS', alias: 'Tata Motors', kind: 'derived' }]);
  expect(s.ready).toBe(true);
  const r = await s.tag({ title: 'Tata Motors recalls cars', summary: '', source: 'ET', category: 'company' });
  expect(r).toEqual({ tags: expect.objectContaining({ instruments: ['TATAMOTORS'] }), version: 1 });
});

it('boot check names active MCX underlyings with no mapping', async () => {
  const warn = jest.fn();
  const prisma = { instrument: { findMany: jest.fn().mockResolvedValue([{ name: 'CRUDEOIL' }, { name: 'STEELREBAR' }]) } };
  const s = new NewsTaggerService(cfg, symbolIndex as never, sectors as never, prisma as never);
  (s as unknown as { logger: { warn: jest.Mock } }).logger.warn = warn;
  await s.checkMcxCoverage();
  expect(warn).toHaveBeenCalledWith('[news-tag] MCX underlying(s) without a news mapping: STEELREBAR');
});

it('flag false: no boot work', () => {
  const prisma = { instrument: { findMany: jest.fn() } };
  const s = new NewsTaggerService(parseNewsEventsConfig({}), symbolIndex as never, sectors as never, prisma as never);
  s.onApplicationBootstrap();
  expect(prisma.instrument.findMany).not.toHaveBeenCalled();
});
