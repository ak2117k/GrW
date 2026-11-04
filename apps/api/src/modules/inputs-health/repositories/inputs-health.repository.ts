import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { EngineNewsTally, ProblemKind } from '../domain/inputs-health';

/** A tracker's underlying, as the master names it. */
export interface OpenUnderlying {
  name: string;
  /** The tracker's exchange (NFO / BFO / MCX / NSE / BSE). */
  exchange: string;
  /** Set for a cash position: its own line. */
  cashRef: { exchange: string; token: string } | null;
}

const date = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** How far back the max-timestamp reads look (keeps them on the ts indexes; older = "none recently"). */
const LOOKBACK_MS = 4 * 86_400_000;

/**
 * Inputs health data access. READ-ONLY on candles_1m, oi_snapshots, news_impacts,
 * entry_engine_decisions, trade_trackers and instruments; writes only inputs_health_alerts (the
 * per-(problem, underlying, IST day) dedupe, so a restart never re-sends the day's alerts). Raw SQL
 * throughout so nothing depends on a regenerated Prisma client. oi_snapshots."timestamp" is UTC
 * without zone (as everywhere else in the repo).
 */
@Injectable()
export class InputsHealthRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Underlyings of OPEN trade_trackers positions (holdings excluded: they are not live-watched). */
  async openUnderlyings(): Promise<OpenUnderlying[]> {
    const rows = await this.prisma.$queryRaw<Array<{ symbol: string; exchange: string; token: string; name: string | null }>>`
      SELECT DISTINCT t.symbol, t.exchange, t.token, i.name
      FROM "trade_trackers" t
      LEFT JOIN "instruments" i ON i.token = t.token AND i.exchange::text = t.exchange
      WHERE t.status = 'OPEN' AND t.kind = 'POSITION'`;
    const out = new Map<string, OpenUnderlying>();
    for (const r of rows) {
      const exchange = String(r.exchange ?? '').toUpperCase();
      const derivative = exchange === 'NFO' || exchange === 'BFO' || exchange === 'MCX';
      const name = String(r.name || r.symbol || '').toUpperCase().replace(/-EQ$/, '');
      if (!name) continue;
      const key = `${name}|${exchange}`;
      if (out.has(key)) continue;
      out.set(key, { name, exchange, cashRef: derivative ? null : { exchange, token: String(r.token) } });
    }
    return [...out.values()];
  }

  /** The near-month future of `name` on `exchange` (earliest active FUT expiring on/after `onOrAfter`). */
  async nearestFuture(name: string, exchange: string, onOrAfter: Date): Promise<{ exchange: string; token: string } | null> {
    const r = await this.prisma.instrument.findFirst({
      where: { name: name.toUpperCase(), exchange, isActive: true, optionType: null, symbol: { endsWith: 'FUT' }, expiry: { gte: onOrAfter } },
      orderBy: { expiry: 'asc' },
      select: { exchange: true, token: true },
    });
    return r ? { exchange: r.exchange, token: r.token } : null;
  }

  /** The NSE cash line of a stock name (`NAME-EQ`, then `NAME`). */
  async cashLine(name: string): Promise<{ exchange: string; token: string } | null> {
    const n = name.toUpperCase();
    for (const symbol of [`${n}-EQ`, n]) {
      const r = await this.prisma.instrument.findFirst({ where: { symbol, exchange: 'NSE' }, select: { exchange: true, token: true } });
      if (r) return r;
    }
    return null;
  }

  /** True when the master has an active CE/PE on `name` expiring on/after `onOrAfter`. */
  async optionable(name: string, onOrAfter: Date): Promise<boolean> {
    const r = await this.prisma.instrument.findFirst({
      where: { name: name.toUpperCase(), optionType: { in: ['CE', 'PE'] }, isActive: true, expiry: { gte: onOrAfter } },
      select: { id: true },
    });
    return !!r;
  }

  /** Newest candles_1m bar start across `refs` (EXCHANGE:token), within the lookback; null when none. */
  async lastBarAt(refs: readonly { exchange: string; token: string }[], now: Date): Promise<Date | null> {
    if (refs.length === 0) return null;
    const since = new Date(now.getTime() - LOOKBACK_MS);
    const tuples = Prisma.join(refs.map((r) => Prisma.sql`(${r.exchange}, ${r.token})`));
    const rows = await this.prisma.$queryRaw<Array<{ last: unknown }>>`
      SELECT max(ts) AS last FROM "candles_1m"
      WHERE (exchange, token) IN (${tuples}) AND ts >= ${since}`;
    return date(rows[0]?.last);
  }

  /** Newest oi_snapshots row on any CE/PE of `name`, within the lookback; null when none. */
  async lastChainAt(name: string, now: Date): Promise<Date | null> {
    const since = new Date(now.getTime() - LOOKBACK_MS);
    const rows = await this.prisma.$queryRaw<Array<{ last: unknown }>>`
      SELECT max(o."timestamp") AS last
      FROM "oi_snapshots" o JOIN "instruments" i ON i.id = o."instrumentId"
      WHERE o."timestamp" >= ${since} AND i.name = ${name.toUpperCase()} AND i."optionType" IN ('CE', 'PE')`;
    return date(rows[0]?.last);
  }

  /** Newest news_impacts.analysed_at, null when the table is empty. */
  async lastNewsAt(): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<Array<{ last: unknown }>>`SELECT max(analysed_at) AS last FROM "news_impacts"`;
    return date(rows[0]?.last);
  }

  /** Per underlying since `from`: entry-engine checks, and those whose reasons carry `news: NO_DATA`. */
  async engineNews(from: Date): Promise<EngineNewsTally[]> {
    const rows = await this.prisma.$queryRaw<Array<{ underlying: string; checks: bigint | number; nodata: bigint | number }>>`
      SELECT d.underlying,
        count(*) AS checks,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(d.reasons) = 'array' THEN d.reasons ELSE '[]'::jsonb END) r
          WHERE r LIKE 'news: NO_DATA%'
        )) AS nodata
      FROM "entry_engine_decisions" d
      WHERE d.at >= ${from}
      GROUP BY d.underlying`;
    return rows.map((r) => ({ underlying: String(r.underlying).toUpperCase(), checks: Number(r.checks), newsNoData: Number(r.nodata) }));
  }

  /**
   * Claims the day's alert for (kind, underlying, istDay): true when THIS call inserted the row (send
   * it), false when it was already claimed — by an earlier run or before a restart.
   */
  async claimAlert(kind: ProblemKind, underlying: string, istDay: string, message: string, at: Date): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "inputs_health_alerts" (id, problem, underlying, ist_day, message, alerted_at)
      VALUES (${randomUUID()}, ${kind}, ${underlying}, ${istDay}, ${message}, ${at})
      ON CONFLICT (problem, underlying, ist_day) DO NOTHING
      RETURNING id`;
    return rows.length > 0;
  }

  /** Drops a claim whose send failed (Telegram down / unconfigured), so the next run retries it. */
  async releaseAlert(kind: ProblemKind, underlying: string, istDay: string): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM "inputs_health_alerts" WHERE problem = ${kind} AND underlying = ${underlying} AND ist_day = ${istDay}`;
  }
}
