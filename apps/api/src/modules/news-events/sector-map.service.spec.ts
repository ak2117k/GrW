import { buildSectorMap, SectorMapService } from './sector-map.service';
import { parseNewsEventsConfig } from './config';

it('buildSectorMap: token → NSE sector name; unknown/null tokens skipped; series suffix stripped', () => {
  const m = buildSectorMap([
    { symbol: 'SBIN', sectorIndexToken: '99926033' },
    { symbol: 'TCS-EQ', sectorIndexToken: '99926013' },
    { symbol: 'XYZ', sectorIndexToken: null },
    { symbol: 'ABC', sectorIndexToken: '123' },
  ]);
  expect([...m.entries()]).toEqual([['SBIN', 'NIFTY PSU BANK'], ['TCS', 'NIFTY IT']]);
});

it('sectorOf is synchronous, null before the first load, served from memory after', async () => {
  const prisma = { stockSector: { findMany: jest.fn().mockResolvedValue([{ symbol: 'HDFCBANK', sectorIndexToken: '99926035' }]) } };
  const s = new SectorMapService(prisma as never, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }));
  expect(s.sectorOf('HDFCBANK')).toBeNull();
  expect(s.ready).toBe(false);
  await expect(s.refresh()).resolves.toBe(1);
  expect(s.sectorOf('hdfcbank-eq')).toBe('NIFTY PVT BANK');
  expect(s.ready).toBe(true);
});

it('a failed refresh keeps the previous map', async () => {
  const prisma = {
    stockSector: {
      findMany: jest.fn().mockResolvedValueOnce([{ symbol: 'SBIN', sectorIndexToken: '99926033' }]).mockRejectedValueOnce(new Error('db down')),
    },
  };
  const s = new SectorMapService(prisma as never, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' }));
  await s.refresh();
  await expect(s.refresh()).resolves.toBe(0);
  expect(s.sectorOf('SBIN')).toBe('NIFTY PSU BANK');
});
