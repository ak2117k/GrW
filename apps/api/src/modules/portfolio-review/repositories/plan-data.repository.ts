import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { RawNews } from '../domain/evidence';
import type { UpcomingEvent } from '../domain/types';

/** One underlying's nearest live NFO future. */
export interface FutureLine {
  name: string;
  instrumentId: string;
  token: string;
  expiry: Date;
}

const IST_MS = 5.5 * 3_600_000;
const istYmd = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

/** Index futures are not stocks: they never enter the idea screen. */
export const INDEX_FUTURE_NAME = /NIFTY|SENSEX|BANKEX/i;

/**
 * Read-only DB reads for the action plan: the last known broker margin, the F&O stock universe
 * (each underlying's nearest NFO future + its NSE cash line), sectors, recent news reads, upcoming
 * company events and the captured futures OI snapshots. No broker calls here.
 */
@Injectable()
export class PlanDataRepository {
  constructor(private readonly prisma: PrismaService) {}

  async latestMargin(userId: string): Promise<{ asOf: Date; availableCash: number } | null> {
    return this.prisma.accountMarginSnapshot.findFirst({ where: { userId }, orderBy: { asOf: 'desc' }, select: { asOf: true, availableCash: true } });
  }

  /** Nearest live NFO future per underlying name (stocks and indices). */
  async futuresByName(now: Date): Promise<Map<string, FutureLine>> {
    const rows = await this.prisma.instrument.findMany({
      where: { exchange: 'NFO', optionType: null, isActive: true, symbol: { endsWith: 'FUT' }, expiry: { gte: new Date(`${istYmd(now)}T00:00:00+05:30`) } },
      select: { id: true, token: true, name: true, expiry: true },
    });
    const out = new Map<string, FutureLine>();
    for (const r of rows) {
      if (!r.name || !r.expiry) continue;
      const name = r.name.trim().toUpperCase();
      const cur = out.get(name);
      if (!cur || r.expiry < cur.expiry) out.set(name, { name, instrumentId: r.id, token: r.token, expiry: r.expiry });
    }
    return out;
  }

  /** NSE cash line (SYMBOL-EQ) token per base name. */
  async cashLines(names: string[]): Promise<Map<string, string>> {
    if (!names.length) return new Map();
    const rows = await this.prisma.instrument.findMany({
      where: { exchange: 'NSE', isActive: true, symbol: { in: names.map((n) => `${n}-EQ`) } },
      select: { symbol: true, token: true },
    });
    return new Map(rows.map((r) => [r.symbol.replace(/-EQ$/, '').toUpperCase(), r.token]));
  }

  /** Industry per base symbol (stock_sectors). */
  async sectors(symbols: string[]): Promise<Map<string, string>> {
    if (!symbols.length) return new Map();
    const rows = await this.prisma.stockSector.findMany({ where: { symbol: { in: symbols } }, select: { symbol: true, industry: true } });
    return new Map(rows.map((r) => [r.symbol.toUpperCase(), r.industry]));
  }

  /** News reads (news_impacts ⋈ news_clusters) naming any of `symbols`, analysed since `since`, MED/HIGH only. */
  async newsFor(symbols: string[], since: Date): Promise<Map<string, RawNews[]>> {
    const out = new Map<string, RawNews[]>();
    if (!symbols.length) return out;
    const impacts = await this.prisma.newsImpact.findMany({
      where: { analysedAt: { gte: since }, magnitude: { in: ['MED', 'HIGH'] }, symbols: { hasSome: symbols } },
      select: { clusterId: true, direction: true, magnitude: true, oneLine: true, symbols: true, analysedAt: true },
      take: 2000,
    });
    if (!impacts.length) return out;
    const clusters = await this.prisma.newsCluster.findMany({
      where: { id: { in: [...new Set(impacts.map((i) => i.clusterId))] } },
      select: { id: true, headline: true, firstSeen: true, boilerplate: true },
    });
    const byId = new Map(clusters.map((c) => [c.id, c]));
    const wanted = new Set(symbols);
    for (const i of impacts) {
      const c = byId.get(i.clusterId);
      if (!c) continue;
      const item: RawNews = { at: c.firstSeen ?? i.analysedAt, headline: c.headline, direction: i.direction, magnitude: i.magnitude, oneLine: i.oneLine, boilerplate: c.boilerplate };
      for (const s of i.symbols) {
        const k = s.toUpperCase();
        if (!wanted.has(k)) continue;
        const list = out.get(k) ?? [];
        list.push(item);
        out.set(k, list);
      }
    }
    return out;
  }

  /** Company events (results, board meetings, ex-dates, splits …) for `symbols` between now and `until`. */
  async eventsFor(symbols: string[], from: Date, until: Date): Promise<Map<string, UpcomingEvent[]>> {
    const out = new Map<string, UpcomingEvent[]>();
    if (!symbols.length) return out;
    const rows = await this.prisma.marketEvent.findMany({
      where: { scope: 'company', key: { in: symbols }, startsAt: { gte: from, lte: until } },
      select: { key: true, kind: true, title: true, startsAt: true },
      orderBy: { startsAt: 'asc' },
    });
    for (const r of rows) {
      const k = r.key.toUpperCase();
      const list = out.get(k) ?? [];
      list.push({ kind: r.kind, title: r.title.slice(0, 160), at: r.startsAt.toISOString() });
      out.set(k, list);
    }
    return out;
  }

  /** Latest futures turnover (LTP × day volume) per instrument from the 3-minute OI capture (last 5 days). */
  async futuresTurnover(instrumentIds: string[], now: Date): Promise<Map<string, number>> {
    if (!instrumentIds.length) return new Map();
    const since = new Date(now.getTime() - 5 * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ instrumentId: string; ltp: number | null; volume: bigint | number }>>`
      SELECT DISTINCT ON (s."instrumentId") s."instrumentId", s."ltp", s."volume"
        FROM "oi_snapshots" s
       WHERE s."instrumentId" = ANY(${instrumentIds}) AND s."timestamp" >= ${since}
       ORDER BY s."instrumentId", s."timestamp" DESC`;
    return new Map(rows.map((r) => [r.instrumentId, (Number(r.ltp) || 0) * Number(r.volume ?? 0)]));
  }

  /** The last captured (OI, LTP) per IST session for one future instrument, oldest first (≤ 40 days). */
  async futuresOiDaily(instrumentId: string, now: Date): Promise<Array<{ date: string; close: number; oi: number }>> {
    const since = new Date(now.getTime() - 40 * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ day: Date | string; oi: bigint | number; ltp: number | null }>>`
      SELECT DISTINCT ON (("timestamp" + interval '330 minutes')::date)
             ("timestamp" + interval '330 minutes')::date AS day, "oi", "ltp"
        FROM "oi_snapshots"
       WHERE "instrumentId" = ${instrumentId} AND "timestamp" >= ${since}
       ORDER BY ("timestamp" + interval '330 minutes')::date, "timestamp" DESC`;
    return rows
      .map((r) => ({ date: typeof r.day === 'string' ? r.day.slice(0, 10) : new Date(r.day).toISOString().slice(0, 10), close: Number(r.ltp) || 0, oi: Number(r.oi) || 0 }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
