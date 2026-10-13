import { CORE_INDEX_INSTRUMENTS } from './core-index-instruments';
import { InstrumentService } from './instrument.service';
import { INDICES, SECTOR_INDICES } from '@td/shared/constants';

/**
 * Production booted with NO row for NIFTY/BANKNIFTY/FINNIFTY in `instruments`:
 * the master refresh only writes cash equities and derivatives, and index rows
 * (AMXIDX) fall through both filters. The scanner, the level-book cron and the
 * daily backfill each then skipped the core indices. These tests pin that the
 * rows are ensured, and that they resolve under the EXACT `where` shapes those
 * three consumers use.
 */

/** A tiny in-memory `instruments` table that answers Prisma-shaped `where`s. */
function fakeTable() {
  const rows: any[] = [];
  let seq = 0;
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in (v as any)) return (v as any).in.includes(row[k]);
      return row[k] === v;
    });
  const repository = {
    findInstrumentsByExchangeToken: jest.fn(async (exchange: string, token: string) =>
      rows.filter((r) => r.exchange === exchange && r.token === token),
    ),
    upsertInstrument: jest.fn(async (d: any) => {
      const hit = rows.find((r) => r.symbol === d.symbol && r.exchange === d.exchange && r.token === d.token);
      if (hit) {
        Object.assign(hit, { segment: d.segment, name: d.name, isActive: true });
        return hit;
      }
      const row = { id: `inst-${++seq}`, isActive: true, expiry: null, strike: null, optionType: null, ...d };
      rows.push(row);
      return row;
    }),
  };
  const prisma = {
    instrument: { findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null) },
  };
  return { rows, repository, prisma };
}

const build = (repository: any, aggregator = { setTokenInstrumentId: jest.fn() }) =>
  new InstrumentService(repository, { get: jest.fn() } as any, aggregator as any);

describe('CORE_INDEX_INSTRUMENTS', () => {
  it('covers the core indices under their canonical symbols', () => {
    const byKey = new Map(CORE_INDEX_INSTRUMENTS.map((r) => [`${r.exchange}:${r.symbol}`, r]));
    expect(byKey.get('NSE:NIFTY')?.token).toBe('99926000');
    expect(byKey.get('NSE:BANKNIFTY')?.token).toBe('99926009');
    expect(byKey.get('NSE:FINNIFTY')?.token).toBe('99926037');
    expect(byKey.get('NSE:MIDCPNIFTY')?.token).toBe('99926074');
    expect(byKey.get('BSE:SENSEX')?.token).toBe('99919000');
  });

  it('covers every INDICES and SECTOR_INDICES token, one row per exchange:token, as segment INDEX', () => {
    const keys = CORE_INDEX_INSTRUMENTS.map((r) => `${r.exchange}:${r.token}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of [...Object.values(INDICES), ...Object.values(SECTOR_INDICES)]) {
      expect(keys).toContain(`${d.exchange}:${d.token}`);
    }
    expect(CORE_INDEX_INSTRUMENTS.every((r) => r.segment === 'INDEX')).toBe(true);
    // 99926009 is BANKNIFTY (what the scanner looks up), not the sector alias.
    expect(CORE_INDEX_INSTRUMENTS.find((r) => r.token === '99926009')?.symbol).toBe('BANKNIFTY');
  });
});

describe('InstrumentService.ensureCoreIndexInstruments', () => {
  it('creates the missing index rows so the scanner, level book and backfill lookups resolve', async () => {
    const { repository, prisma } = fakeTable();
    const aggregator = { setTokenInstrumentId: jest.fn() };
    const svc = build(repository, aggregator);

    await svc.ensureCoreIndexInstruments();

    // UniverseScannerWorker: symbol + exchange + index segment.
    for (const symbol of ['NIFTY', 'BANKNIFTY']) {
      const inst = await prisma.instrument.findFirst({
        where: { symbol, exchange: 'NSE', segment: { in: ['INDEX', 'INDICES', 'COMMODITY'] } },
      });
      expect(inst).not.toBeNull();
    }
    // LevelBookCron + DailyBackfillWorker: token + exchange.
    for (const token of ['99926000', '99926009', '99926037']) {
      expect(await prisma.instrument.findFirst({ where: { token, exchange: 'NSE' } })).not.toBeNull();
    }
    // Live index ticks must aggregate into candles for the new rows.
    const nifty = await prisma.instrument.findFirst({ where: { token: '99926000', exchange: 'NSE' } });
    expect(aggregator.setTokenInstrumentId).toHaveBeenCalledWith('99926000', (nifty as any).id);
    expect(svc.getByExchangeTokenSync('NSE', '99926000')?.symbol).toBe('NIFTY');
  });

  it('is idempotent: a second pass writes nothing (so it never bumps updatedAt / the boot-skip clock)', async () => {
    const { repository } = fakeTable();
    const svc = build(repository);
    await svc.ensureCoreIndexInstruments();
    repository.upsertInstrument.mockClear();

    const created = await svc.ensureCoreIndexInstruments();

    expect(created).toBe(0);
    expect(repository.upsertInstrument).not.toHaveBeenCalled();
  });

  it('does not add a second row for a token another symbol already owns', async () => {
    const { rows, repository } = fakeTable();
    rows.push({ id: 'legacy', symbol: 'Nifty 50', token: '99926000', exchange: 'NSE', segment: 'INDICES', isActive: true });
    const svc = build(repository);

    await svc.ensureCoreIndexInstruments();

    expect(rows.filter((r) => r.exchange === 'NSE' && r.token === '99926000')).toHaveLength(1);
  });

  it('repairs a canonical row that was deactivated or mis-segmented', async () => {
    const { rows, repository } = fakeTable();
    rows.push({ id: 'old', symbol: 'NIFTY', token: '99926000', exchange: 'NSE', segment: 'NSE', isActive: false });
    const svc = build(repository);

    await svc.ensureCoreIndexInstruments();

    expect(rows.find((r) => r.id === 'old')).toMatchObject({ segment: 'INDEX', isActive: true });
  });

  it('never throws when the database fails', async () => {
    const repository = {
      findInstrumentsByExchangeToken: jest.fn().mockRejectedValue(new Error('db down')),
      upsertInstrument: jest.fn(),
    };
    await expect(build(repository).ensureCoreIndexInstruments()).resolves.toBe(0);
  });
});
