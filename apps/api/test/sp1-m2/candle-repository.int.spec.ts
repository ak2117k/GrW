import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaCandleRepo } from '../../src/modules/market-hub/candles/candle-repository';
import type { InstrumentRef } from '../../src/modules/market-hub/hub.types';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throw-away database with all migrations applied');

const db = new PrismaClient({ datasources: { db: { url } } });
const repo = new PrismaCandleRepo(db);
const ist = (s: string) => Date.parse(`${s}+05:30`);
const REF: InstrumentRef = { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' };
const MCX: InstrumentRef = { exchange: 'MCX', token: '2885', symbol: 'SAME-TOKEN' };
const bar = (at: string, close: number, volume = 10) => ({ ts: ist(at), open: close, high: close + 1, low: close - 1, close, volume });

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "candles_1m", "candles_1h", "candles_1d", "candle_coverage"');
});
afterAll(() => db.$disconnect());

describe('PrismaCandleRepo (real database)', () => {
  it('reads a half-open range ascending, with numbers and oi only when present', async () => {
    await repo.upsert('1m', REF, [bar('2026-10-07T10:01:00', 2), { ...bar('2026-10-07T10:00:00', 1, 3_000_000_000), oi: 5 }], 'broker');
    await repo.upsert('1m', REF, [bar('2026-10-07T10:02:00', 3)], 'broker');
    const out = await repo.read('1m', REF, ist('2026-10-07T10:00:00'), ist('2026-10-07T10:02:00'));
    expect(out).toEqual([
      { ts: ist('2026-10-07T10:00:00'), open: 1, high: 2, low: 0, close: 1, volume: 3_000_000_000, oi: 5 },
      { ts: ist('2026-10-07T10:01:00'), open: 2, high: 3, low: 1, close: 2, volume: 10 },
    ]);
  });

  it('broker overwrites tick, tick never overwrites broker, tick overwrites tick', async () => {
    const t = '2026-10-07T10:00:00';
    await repo.upsert('1m', REF, [bar(t, 100)], 'tick');
    await repo.upsert('1m', REF, [bar(t, 101)], 'tick');
    expect((await repo.read('1m', REF, ist(t), ist(t) + 60_000))[0].close).toBe(101);
    await repo.upsert('1m', REF, [bar(t, 200)], 'broker');
    await repo.upsert('1m', REF, [bar(t, 300)], 'tick');
    expect((await repo.read('1m', REF, ist(t), ist(t) + 60_000))[0].close).toBe(200);
  });

  it('keeps the same token on two exchanges apart', async () => {
    await repo.upsert('1d', REF, [bar('2026-10-07T00:00:00', 1)], 'broker');
    await repo.upsert('1d', MCX, [bar('2026-10-07T00:00:00', 2)], 'broker');
    expect((await repo.read('1d', MCX, ist('2026-10-07T00:00:00'), ist('2026-10-08T00:00:00')))[0].close).toBe(2);
  });

  it('groups 1m bars into 30m buckets aligned to 09:15 IST', async () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({
      ts: ist('2026-10-07T09:15:00') + i * 60_000, open: 100 + i, high: 200 + i, low: 50 + i, close: 100 + i, volume: 1,
    }));
    await repo.upsert('1m', REF, bars, 'broker');
    const out = await repo.readBucketed(REF, 30, 555, ist('2026-10-07T00:00:00'), ist('2026-10-08T00:00:00'));
    expect(out).toEqual([
      { ts: ist('2026-10-07T09:15:00'), open: 100, high: 229, low: 50, close: 129, volume: 30 },
      { ts: ist('2026-10-07T09:45:00'), open: 130, high: 259, low: 80, close: 159, volume: 30 },
    ]);
  });

  it('counts per IST day (not UTC day)', async () => {
    await repo.upsert('1m', REF, [bar('2026-10-07T23:50:00', 1), bar('2026-10-08T00:10:00', 2)], 'tick');
    expect(await repo.dayCounts('1m', REF, ist('2026-10-07T00:00:00'), ist('2026-10-09T00:00:00'))).toEqual(
      new Map([['2026-10-07', 1], ['2026-10-08', 1]]),
    );
  });

  it('remembers coverage idempotently and lists tick instruments', async () => {
    await repo.markCovered('1m', REF, ['2026-10-06', '2026-10-05']);
    await repo.markCovered('1m', REF, ['2026-10-06']);
    expect(await repo.coveredDays('1m', REF, ['2026-10-06', '2026-10-01'])).toEqual(new Set(['2026-10-06']));
    expect(await repo.coveredDays('1h', REF, ['2026-10-06'])).toEqual(new Set());
    await repo.upsert('1m', REF, [bar('2026-10-07T10:00:00', 1)], 'tick');
    await repo.upsert('1m', MCX, [bar('2026-10-07T10:00:00', 1)], 'broker');
    expect(await repo.tickInstruments(ist('2026-10-07T00:00:00'))).toEqual([{ exchange: 'NSE', token: '2885' }]);
  });

  it('a duplicate ts inside one upsert succeeds and the last occurrence wins', async () => {
    const t = '2026-10-07T10:00:00';
    await repo.upsert('1m', REF, [bar(t, 1), bar(t, 2)], 'broker');
    const m = await repo.read('1m', REF, ist(t), ist(t) + 60_000);
    expect(m).toHaveLength(1);
    expect(m[0].close).toBe(2);
    const d = '2026-10-07T00:00:00';
    await repo.upsert('1d', REF, [bar(d, 1), bar(d, 2)], 'broker');
    const day = await repo.read('1d', REF, ist(d), ist('2026-10-08T00:00:00'));
    expect(day).toHaveLength(1);
    expect(day[0].close).toBe(2);
  });

  it('writes more than one batch', async () => {
    const bars = Array.from({ length: 1500 }, (_, i) => ({ ts: ist('2026-10-01T09:15:00') + i * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    await repo.upsert('1m', REF, bars, 'broker');
    expect(await repo.read('1m', REF, ist('2026-10-01T00:00:00'), ist('2026-10-03T00:00:00'))).toHaveLength(1500);
  });

  it('groups a whole IST day into one 1440-minute bucket at IST midnight (today’s 1d bar)', async () => {
    await repo.upsert('1m', REF, [bar('2026-10-07T09:15:00', 1, 5), bar('2026-10-07T15:29:00', 9, 7)], 'tick');
    const out = await repo.readBucketed(REF, 1440, 0, ist('2026-10-07T00:00:00'), ist('2026-10-08T00:00:00'));
    expect(out).toEqual([{ ts: ist('2026-10-07T00:00:00'), open: 1, high: 10, low: 0, close: 9, volume: 12 }]);
  });

  it('candles_1m is a hypertable when TimescaleDB is installed (deploy/sql/candles-timescale.sql, run twice)', async () => {
    const avail = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'timescaledb'`,
    );
    if (avail[0].n === 0) return; // plain Postgres: the deploy step does nothing there
    // The migration no longer touches TimescaleDB: the deploy step applies it, on every deploy.
    const sql = readFileSync(join(__dirname, '../../../../deploy/sql/candles-timescale.sql'), 'utf8');
    await db.$executeRawUnsafe(sql);
    await db.$executeRawUnsafe(sql); // idempotent: a second deploy changes nothing and raises nothing
    const ht = await db.$queryRawUnsafe<Array<{ n: number; compression: boolean }>>(
      `SELECT count(*)::int AS n, bool_and(compression_enabled) AS compression
       FROM timescaledb_information.hypertables WHERE hypertable_name = 'candles_1m'`,
    );
    expect(ht[0]).toEqual({ n: 1, compression: true });
    const jobs = await db.$queryRawUnsafe<Array<{ proc_name: string }>>(
      `SELECT proc_name::text AS proc_name FROM timescaledb_information.jobs
       WHERE hypertable_name = 'candles_1m' AND proc_name IN ('policy_compression', 'policy_retention')
       ORDER BY proc_name`,
    );
    expect(jobs.map((j) => j.proc_name)).toEqual(['policy_compression', 'policy_retention']);
  });
});
