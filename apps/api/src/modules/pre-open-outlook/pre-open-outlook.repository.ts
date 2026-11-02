import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ChartBar, GlobalChart } from './domain/global-chart';
import type { PreOpenOutlook } from './domain/outlook';

export interface SnapshotRow {
  symbol: string;
  price: number | null;
  priceTime: Date | null;
  fetchedAt: Date;
  status: 'OK' | 'NO_DATA';
  source: string;
  reason: string | null;
  intervalMs: number | null;
  bars: ChartBar[] | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Data access of the pre-open outlook. Writes ONLY global_price_snapshots and pre_open_outlooks
 * (raw SQL, migration 20261102130000_global_price_snapshots, so nothing depends on a regenerated
 * Prisma client); reads instruments, candles_1m / candles and news_clusters.
 */
@Injectable()
export class PreOpenOutlookRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** One snapshot; a repeat of the same (symbol, price time) is ignored. */
  async insertSnapshot(r: SnapshotRow): Promise<void> {
    const bars = r.bars ? JSON.stringify(r.bars) : null;
    await this.prisma.$executeRaw`
      INSERT INTO "global_price_snapshots" ("id", "symbol", "price", "price_time", "fetched_at", "status", "source", "reason", "interval_ms", "bars")
      VALUES (${randomUUID()}, ${r.symbol}, ${r.price}, ${r.priceTime}, ${r.fetchedAt}, ${r.status}, ${r.source}, ${r.reason}, ${r.intervalMs}, ${bars}::jsonb)
      ON CONFLICT ("symbol", "price_time") DO NOTHING`;
  }

  /** The newest OK snapshot of `symbol` fetched at or before `at`, as a chart (its stored bars). */
  async latestChart(symbol: string, at: Date): Promise<GlobalChart | null> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT symbol, price, price_time, interval_ms, bars FROM "global_price_snapshots"
      WHERE symbol = ${symbol} AND status = 'OK' AND fetched_at <= ${at}
      ORDER BY fetched_at DESC LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    const bars = Array.isArray(r.bars) ? (r.bars as ChartBar[]).filter((b) => num(b.t) !== null && num(b.close) !== null) : [];
    return {
      symbol: String(r.symbol),
      price: num(r.price),
      priceAt: r.price_time instanceof Date ? r.price_time.getTime() : null,
      intervalMs: num(r.interval_ms) ?? 3_600_000,
      bars,
    };
  }

  /** The nearest non-expired future of an MCX / NFO underlying (as the entry engine resolves it). */
  async nearestFuture(name: string, from: Date): Promise<{ exchange: string; token: string; symbol: string } | null> {
    const r = await this.prisma.instrument.findFirst({
      where: { name: name.toUpperCase(), exchange: { in: ['MCX', 'NFO', 'BFO'] }, optionType: null, symbol: { endsWith: 'FUT' }, isActive: true, expiry: { gte: from } },
      orderBy: { expiry: 'asc' },
      select: { exchange: true, token: true, symbol: true },
    });
    return r ?? null;
  }

  /**
   * The last 1-minute bar strictly before `before` (≤ 5 days back) whose IST time is inside the session
   * [openMin, closeMin) — off-session bars (a Saturday-morning stray print) are not a close. candles_1m,
   * else the legacy candles table (UTC without zone).
   */
  async lastBarBefore(exchange: string, token: string, before: Date, openMin: number, closeMin: number): Promise<{ price: number; at: Date } | null> {
    const from = new Date(before.getTime() - 5 * 86_400_000);
    const hub = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT ts, close FROM "candles_1m" WHERE exchange = ${exchange} AND token = ${token}
        AND ts >= ${from.toISOString()}::timestamptz AND ts < ${before.toISOString()}::timestamptz AND close > 0
        AND (extract(hour from ts AT TIME ZONE 'Asia/Kolkata') * 60 + extract(minute from ts AT TIME ZONE 'Asia/Kolkata')) >= ${openMin}
        AND (extract(hour from ts AT TIME ZONE 'Asia/Kolkata') * 60 + extract(minute from ts AT TIME ZONE 'Asia/Kolkata')) < ${closeMin}
      ORDER BY ts DESC LIMIT 1`;
    const h = hub[0];
    if (h && num(h.close) !== null) return { price: num(h.close) as number, at: h.ts as Date };
    const tbl = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT c."timestamp" AS ts, c.close FROM "candles" c JOIN "instruments" i ON i.id = c."instrumentId"
      WHERE i.exchange = ${exchange} AND i.token = ${token} AND c.timeframe = '1m' AND c."timestamp" >= ${from} AND c."timestamp" < ${before} AND c.close > 0
        AND (extract(hour from (c."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata') * 60 + extract(minute from (c."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')) >= ${openMin}
        AND (extract(hour from (c."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata') * 60 + extract(minute from (c."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')) < ${closeMin}
      ORDER BY c."timestamp" DESC LIMIT 1`;
    const t = tbl[0];
    return t && num(t.close) !== null ? { price: num(t.close) as number, at: t.ts as Date } : null;
  }

  /** Clusters first seen in (from, to] (headline-move fallback). */
  async clustersBetween(from: Date, to: Date): Promise<Array<{ id: string; headline: string; firstSeen: Date }>> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT id, headline, first_seen FROM "news_clusters" WHERE first_seen > ${from} AND first_seen <= ${to} AND boilerplate = false
      ORDER BY first_seen DESC LIMIT 1000`;
    return rows.map((r) => ({ id: String(r.id), headline: String(r.headline ?? ''), firstSeen: r.first_seen as Date }));
  }

  async insertOutlook(o: PreOpenOutlook): Promise<string> {
    const id = randomUUID();
    const payload = JSON.stringify(o);
    await this.prisma.$executeRaw`
      INSERT INTO "pre_open_outlooks" ("id", "underlying", "session_date", "at", "bias", "confidence", "score", "gap_pct", "gap_points", "last_close", "payload", "summary")
      VALUES (${id}, ${o.underlying}, ${o.sessionDate}::date, ${new Date(o.at)}, ${o.bias}, ${o.confidence}, ${o.score}, ${o.gap?.pct ?? null}, ${o.gap?.points ?? null},
        ${o.lastClose?.price ?? null}, ${payload}::jsonb, ${o.summary})`;
    return id;
  }

  /** The newest outlook per underlying computed at or after `since`. */
  async latestOutlooks(since: Date): Promise<PreOpenOutlook[]> {
    const rows = await this.prisma.$queryRaw<Array<{ payload: unknown }>>`
      SELECT DISTINCT ON (underlying) payload FROM "pre_open_outlooks" WHERE at >= ${since}
      ORDER BY underlying, at DESC`;
    return rows.map((r) => r.payload as PreOpenOutlook);
  }
}
