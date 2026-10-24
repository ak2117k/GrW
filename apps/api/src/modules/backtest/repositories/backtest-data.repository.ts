import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { Bar } from '../data/backtest-data.domain';

export interface DatasetRow {
  id: number;
  symbol: string;
  exchange: string;
  interval: string;
  fromTs: Date | null;
  toTs: Date | null;
  rows: number;
  source: string;
  updatedAt: Date;
}

interface RawBar {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const INSERT_CHUNK = 5_000;
const toBar = (r: RawBar): Bar => ({
  timestamp: r.ts instanceof Date ? r.ts : new Date(r.ts),
  open: Number(r.open),
  high: Number(r.high),
  low: Number(r.low),
  close: Number(r.close),
  volume: Number(r.volume ?? 0),
});

/** Merge one source into a comma set ("angel" + "research-1m,yahoo" → "angel,research-1m,yahoo"). */
export function mergeSources(existing: string | null | undefined, add: string): string {
  const set = new Set((existing ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  set.add(add);
  return [...set].sort().join(',');
}

/**
 * The bucket expression shared by the roll-up queries: a bar's bucket START in UTC, anchored at
 * 09:15 IST (555 min), or the IST session date at 09:15 for daily (1440).
 */
function bucketSql(minutes: number): Prisma.Sql {
  if (minutes >= 1440) {
    return Prisma.sql`((date_trunc('day', ts AT TIME ZONE 'Asia/Kolkata') + interval '555 minutes') AT TIME ZONE 'Asia/Kolkata')`;
  }
  return Prisma.sql`((date_trunc('day', ts AT TIME ZONE 'Asia/Kolkata')
      + make_interval(mins => 555 + ((((extract(hour from ts AT TIME ZONE 'Asia/Kolkata') * 60
      + extract(minute from ts AT TIME ZONE 'Asia/Kolkata'))::int - 555) / ${minutes}::int) * ${minutes}::int)))
      AT TIME ZONE 'Asia/Kolkata')`;
}

function sessionFilterSql(minutes: number): Prisma.Sql {
  if (minutes >= 1440) return Prisma.sql`TRUE`;
  return Prisma.sql`((extract(hour from ts AT TIME ZONE 'Asia/Kolkata') * 60
      + extract(minute from ts AT TIME ZONE 'Asia/Kolkata')) BETWEEN 555 AND 929)`;
}

/** Raw-SQL access to backtest_datasets / backtest_bars / backtest_fetch_jobs / backtest_ai_requests. */
@Injectable()
export class BacktestDataRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── catalogue ──────────────────────────────────────────────────────────────────────────────

  async listDatasets(symbol?: string): Promise<DatasetRow[]> {
    return this.prisma.backtestDataset.findMany({
      where: symbol ? { symbol: symbol.toUpperCase() } : undefined,
      orderBy: [{ symbol: 'asc' }, { exchange: 'asc' }, { interval: 'asc' }],
    });
  }

  async findDataset(symbol: string, exchange: string, interval: string): Promise<DatasetRow | null> {
    return this.prisma.backtestDataset.findUnique({
      where: { symbol_exchange_interval: { symbol: symbol.toUpperCase(), exchange: exchange.toUpperCase(), interval } },
    });
  }

  /** The dataset row, created when missing; `source` merged into its source set. */
  async ensureDataset(symbol: string, exchange: string, interval: string, source: string): Promise<DatasetRow> {
    const existing = await this.findDataset(symbol, exchange, interval);
    if (existing) {
      const merged = mergeSources(existing.source, source);
      if (merged === existing.source) return existing;
      return this.prisma.backtestDataset.update({ where: { id: existing.id }, data: { source: merged } });
    }
    return this.prisma.backtestDataset.upsert({
      where: { symbol_exchange_interval: { symbol: symbol.toUpperCase(), exchange: exchange.toUpperCase(), interval } },
      create: { symbol: symbol.toUpperCase(), exchange: exchange.toUpperCase(), interval, source },
      update: {},
    });
  }

  /** Recompute [fromTs, toTs] and rows from the bars themselves. */
  async refreshStats(datasetId: number): Promise<DatasetRow> {
    const [s] = await this.prisma.$queryRaw<Array<{ f: Date | null; t: Date | null; n: number }>>`
      SELECT min(ts) AS f, max(ts) AS t, count(*)::int AS n FROM backtest_bars WHERE dataset_id = ${datasetId}`;
    return this.prisma.backtestDataset.update({
      where: { id: datasetId },
      data: { fromTs: s?.f ?? null, toTs: s?.t ?? null, rows: s?.n ?? 0 },
    });
  }

  // ── bars ───────────────────────────────────────────────────────────────────────────────────

  async countBars(datasetId: number, from: Date, to: Date): Promise<number> {
    const [r] = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM backtest_bars WHERE dataset_id = ${datasetId} AND ts >= ${from} AND ts <= ${to}`;
    return r?.n ?? 0;
  }

  /**
   * Bars of one dataset in [from, to], rolled up in SQL to `bucketMinutes` when that is coarser
   * than the stored interval (`storedMinutes`), so a 10-year 1m series never crosses the wire raw.
   * `limit` bounds the rows read (callers pass their bar cap + 1 to detect an oversize request).
   */
  async readBars(
    datasetId: number,
    from: Date,
    to: Date,
    storedMinutes: number,
    bucketMinutes: number,
    limit = 1_000_000,
  ): Promise<Bar[]> {
    if (bucketMinutes === storedMinutes) {
      const rows = await this.prisma.$queryRaw<RawBar[]>`
        SELECT ts, open, high, low, close, volume FROM backtest_bars
        WHERE dataset_id = ${datasetId} AND ts >= ${from} AND ts <= ${to} ORDER BY ts LIMIT ${limit}`;
      return rows.map(toBar);
    }
    const rows = await this.prisma.$queryRaw<RawBar[]>`
      SELECT ${bucketSql(bucketMinutes)} AS ts,
             (array_agg(open ORDER BY ts))[1] AS open, max(high) AS high, min(low) AS low,
             (array_agg(close ORDER BY ts DESC))[1] AS close, sum(volume) AS volume
      FROM backtest_bars
      WHERE dataset_id = ${datasetId} AND ts >= ${from} AND ts <= ${to} AND ${sessionFilterSql(bucketMinutes)}
      GROUP BY 1 ORDER BY 1 LIMIT ${limit}`;
    return rows.map(toBar);
  }

  /** Insert bars, keeping any bar already held (ON CONFLICT DO NOTHING). Returns rows inserted. */
  async insertBars(datasetId: number, bars: Array<Bar & { oi?: number | null }>): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < bars.length; i += INSERT_CHUNK) {
      const chunk = bars.slice(i, i + INSERT_CHUNK).filter((b) =>
        [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v)) && !Number.isNaN(b.timestamp.getTime()));
      if (chunk.length === 0) continue;
      inserted += await this.prisma.$executeRaw`
        INSERT INTO backtest_bars (dataset_id, ts, open, high, low, close, volume, oi)
        SELECT ${datasetId}::int, t.ts, t.o, t.h, t.l, t.c, t.v, t.oi
        FROM unnest(${chunk.map((b) => b.timestamp)}::timestamptz[], ${chunk.map((b) => b.open)}::float8[],
                    ${chunk.map((b) => b.high)}::float8[], ${chunk.map((b) => b.low)}::float8[],
                    ${chunk.map((b) => b.close)}::float8[], ${chunk.map((b) => (Number.isFinite(b.volume) ? b.volume : 0))}::float8[],
                    ${chunk.map((b) => (b.oi == null || !Number.isFinite(b.oi) ? null : b.oi))}::float8[])
             AS t(ts, o, h, l, c, v, oi)
        ON CONFLICT (dataset_id, ts) DO NOTHING`;
    }
    return inserted;
  }

  /** MBM broker 1m bars (mbm_bars_1m, the live store: last ~60 days + forward) rolled up to `bucketMinutes`. */
  async readMbmBars(series: string, from: Date, to: Date, bucketMinutes: number, limit = 1_000_000): Promise<Bar[]> {
    if (bucketMinutes === 1) {
      const rows = await this.prisma.$queryRaw<RawBar[]>`
        SELECT ts, open, high, low, close, volume FROM mbm_bars_1m
        WHERE series = ${series} AND ts >= ${from} AND ts <= ${to} ORDER BY ts LIMIT ${limit}`;
      return rows.map(toBar);
    }
    const rows = await this.prisma.$queryRaw<RawBar[]>`
      SELECT ${bucketSql(bucketMinutes)} AS ts,
             (array_agg(open ORDER BY ts))[1] AS open, max(high) AS high, min(low) AS low,
             (array_agg(close ORDER BY ts DESC))[1] AS close, sum(volume) AS volume
      FROM mbm_bars_1m
      WHERE series = ${series} AND ts >= ${from} AND ts <= ${to} AND ${sessionFilterSql(bucketMinutes)}
      GROUP BY 1 ORDER BY 1 LIMIT ${limit}`;
    return rows.map(toBar);
  }

  // ── fetch jobs ─────────────────────────────────────────────────────────────────────────────

  async createFetchJob(data: {
    userId: string;
    symbol: string;
    exchange: string;
    interval: string;
    fromTs: Date;
    toTs: Date;
  }) {
    return this.prisma.backtestFetchJob.create({ data: { ...data, status: 'running' } });
  }

  async updateFetchJob(
    id: string,
    data: Partial<{ status: string; provider: string; calls: number; rows: number; message: string; finishedAt: Date }>,
  ) {
    return this.prisma.backtestFetchJob.update({ where: { id }, data });
  }

  async recentFetchJobs(limit = 20) {
    return this.prisma.backtestFetchJob.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  }

  /** Angel calls spent by fetch jobs created since `since` (the daily cap). */
  async callsSince(since: Date): Promise<number> {
    const r = await this.prisma.backtestFetchJob.aggregate({
      _sum: { calls: true },
      where: { createdAt: { gte: since }, provider: 'angel' },
    });
    return r._sum.calls ?? 0;
  }

  // ── assistant requests ─────────────────────────────────────────────────────────────────────

  async createAiRequest(data: { userId: string; requestHash: string; prompt: string; status: string; error?: string }) {
    return this.prisma.backtestAiRequest.create({ data });
  }

  async updateAiRequest(id: string, data: Prisma.BacktestAiRequestUpdateInput) {
    return this.prisma.backtestAiRequest.update({ where: { id }, data });
  }

  async getAiRequest(id: string) {
    return this.prisma.backtestAiRequest.findUnique({ where: { id } });
  }

  async recentAiRequests(userId: string, limit = 10) {
    return this.prisma.backtestAiRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** Newest finished request with this hash since `since` (the cache). */
  async findCachedAiRequest(requestHash: string, since: Date) {
    return this.prisma.backtestAiRequest.findFirst({
      where: { requestHash, status: 'done', createdAt: { gte: since }, cachedFrom: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** A request with this hash still in flight (dedupe a double-click). */
  async findInflightAiRequest(userId: string, requestHash: string, since: Date) {
    return this.prisma.backtestAiRequest.findFirst({
      where: {
        userId,
        requestHash,
        createdAt: { gte: since },
        status: { in: ['queued', 'spec', 'fetching', 'running', 'summarising'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Requests that spent at least one model call since `since` (the daily cap; cache hits are free). */
  async aiRequestsWithLlmSince(userId: string, since: Date): Promise<number> {
    return this.prisma.backtestAiRequest.count({ where: { userId, createdAt: { gte: since }, llmCalls: { gt: 0 } } });
  }
}
