import { Prisma, type PrismaClient } from '@prisma/client';
import type { InstrumentRef } from '../hub.types';
import type { CandleTable, HubCandle } from './candle.types';

export interface CandleRepo {
  read(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<HubCandle[]>;
  /** 1-minute bars grouped into `stepMin` buckets aligned to `originMinIst` (IST minutes after midnight). */
  readBucketed(ref: InstrumentRef, stepMin: number, originMinIst: number, from: number, to: number): Promise<HubCandle[]>;
  /** Stored bars per IST day in [from, to). */
  dayCounts(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<Map<string, number>>;
  upsert(table: CandleTable, ref: InstrumentRef, candles: readonly HubCandle[], source: 'tick' | 'broker'): Promise<void>;
  coveredDays(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<Set<string>>;
  markCovered(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<void>;
  /** Instruments with tick-built 1m bars at or after `sinceMs`. */
  tickInstruments(sinceMs: number): Promise<Array<Pick<InstrumentRef, 'exchange' | 'token'>>>;
}

type Sql = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

const TABLE: Record<CandleTable, Prisma.Sql> = {
  '1m': Prisma.raw('"candles_1m"'),
  '1h': Prisma.raw('"candles_1h"'),
  '1d': Prisma.raw('"candles_1d"'),
};
const BATCH = 1000;

interface Row {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint | number | null;
  oi: bigint | number | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

function toCandle(r: Row): HubCandle {
  const c: HubCandle = {
    ts: r.ts.getTime(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume ?? 0),
  };
  if (r.oi !== null && r.oi !== undefined) c.oi = Number(r.oi);
  return c;
}

/** date_bin origin: any past date at the IST session-open minute. */
export function bucketOrigin(originMinIst: number): string {
  const hh = String(Math.floor(originMinIst / 60)).padStart(2, '0');
  const mm = String(originMinIst % 60).padStart(2, '0');
  return `2000-01-03T${hh}:${mm}:00+05:30`;
}

/**
 * The CandleStore's tables, through raw SQL (Prisma's query builder has no
 * upsert-with-condition or date_bin). Every timestamp parameter is an ISO
 * string cast to timestamptz so the server's TimeZone setting cannot shift it.
 */
export class PrismaCandleRepo implements CandleRepo {
  constructor(private readonly db: Sql) {}

  async read(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<HubCandle[]> {
    const oi = table === '1m' ? Prisma.sql`oi` : Prisma.sql`NULL::bigint AS oi`;
    const rows = await this.db.$queryRaw<Row[]>`
      SELECT ts, open, high, low, close, volume, ${oi}
      FROM ${TABLE[table]}
      WHERE exchange = ${ref.exchange} AND token = ${ref.token}
        AND ts >= ${iso(from)}::timestamptz AND ts < ${iso(to)}::timestamptz
      ORDER BY ts`;
    return rows.map(toCandle);
  }

  async readBucketed(ref: InstrumentRef, stepMin: number, originMinIst: number, from: number, to: number): Promise<HubCandle[]> {
    const rows = await this.db.$queryRaw<Row[]>`
      SELECT date_bin(${`${stepMin} minutes`}::interval, ts, ${bucketOrigin(originMinIst)}::timestamptz) AS ts,
             (array_agg(open ORDER BY ts))[1] AS open,
             max(high) AS high,
             min(low) AS low,
             (array_agg(close ORDER BY ts DESC))[1] AS close,
             sum(volume)::bigint AS volume,
             (array_agg(oi ORDER BY ts DESC) FILTER (WHERE oi IS NOT NULL))[1] AS oi
      FROM "candles_1m"
      WHERE exchange = ${ref.exchange} AND token = ${ref.token}
        AND ts >= ${iso(from)}::timestamptz AND ts < ${iso(to)}::timestamptz
      GROUP BY 1
      ORDER BY 1`;
    return rows.map(toCandle);
  }

  async dayCounts(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<Map<string, number>> {
    const rows = await this.db.$queryRaw<Array<{ day: string; n: number }>>`
      SELECT to_char(ts AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM ${TABLE[table]}
      WHERE exchange = ${ref.exchange} AND token = ${ref.token}
        AND ts >= ${iso(from)}::timestamptz AND ts < ${iso(to)}::timestamptz
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.day, Number(r.n)] as const));
  }

  async upsert(table: CandleTable, ref: InstrumentRef, candles: readonly HubCandle[], source: 'tick' | 'broker'): Promise<void> {
    for (let i = 0; i < candles.length; i += BATCH) {
      const chunk = candles.slice(i, i + BATCH);
      if (table === '1m') {
        const values = Prisma.join(
          chunk.map(
            (c) => Prisma.sql`(${ref.exchange}, ${ref.token}, ${iso(c.ts)}::timestamptz, ${c.open}::float8, ${c.high}::float8,
              ${c.low}::float8, ${c.close}::float8, ${Math.round(c.volume)}::bigint,
              ${c.oi === undefined ? null : Math.round(c.oi)}::bigint, ${source})`,
          ),
        );
        // broker always wins; a tick bar only replaces another tick bar.
        await this.db.$executeRaw`
          INSERT INTO "candles_1m" (exchange, token, ts, open, high, low, close, volume, oi, source)
          VALUES ${values}
          ON CONFLICT (exchange, token, ts) DO UPDATE SET
            open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
            volume = EXCLUDED.volume, oi = EXCLUDED.oi, source = EXCLUDED.source
          WHERE "candles_1m".source = 'tick' OR EXCLUDED.source = 'broker'`;
      } else {
        const values = Prisma.join(
          chunk.map(
            (c) => Prisma.sql`(${ref.exchange}, ${ref.token}, ${iso(c.ts)}::timestamptz, ${c.open}::float8, ${c.high}::float8,
              ${c.low}::float8, ${c.close}::float8, ${Math.round(c.volume)}::bigint)`,
          ),
        );
        await this.db.$executeRaw`
          INSERT INTO ${TABLE[table]} (exchange, token, ts, open, high, low, close, volume)
          VALUES ${values}
          ON CONFLICT (exchange, token, ts) DO UPDATE SET
            open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
            volume = EXCLUDED.volume`;
      }
    }
  }

  async coveredDays(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<Set<string>> {
    if (days.length === 0) return new Set();
    const rows = await this.db.$queryRaw<Array<{ day: string }>>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day FROM "candle_coverage"
      WHERE exchange = ${ref.exchange} AND token = ${ref.token} AND tf = ${table}
        AND day = ANY(${[...days]}::date[])`;
    return new Set(rows.map((r) => r.day));
  }

  async markCovered(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<void> {
    if (days.length === 0) return;
    await this.db.$executeRaw`
      INSERT INTO "candle_coverage" (exchange, token, tf, day)
      SELECT ${ref.exchange}, ${ref.token}, ${table}, d FROM unnest(${[...days]}::date[]) AS d
      ON CONFLICT (exchange, token, tf, day) DO UPDATE SET fetched_at = now()`;
  }

  async tickInstruments(sinceMs: number): Promise<Array<Pick<InstrumentRef, 'exchange' | 'token'>>> {
    const rows = await this.db.$queryRaw<Array<{ exchange: string; token: string }>>`
      SELECT DISTINCT exchange, token FROM "candles_1m"
      WHERE source = 'tick' AND ts >= ${iso(sinceMs)}::timestamptz`;
    return rows.map((r) => ({ exchange: r.exchange as InstrumentRef['exchange'], token: r.token }));
  }
}
