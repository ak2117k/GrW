import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { INDEX_UNDERLYINGS } from '../market-hub/underlying';
import type { NewsRow } from '../night-report/domain/night-report.logic';
import type { DailyBar } from './domain/outcome';
import type { TrackerLite } from './domain/positions';
import type { FactorScore, NewsIdea, Scorecard, ScoreWindow } from './scorecard.types';
import { istYmd } from './domain/windows';

export interface StoredIdea extends NewsIdea {
  id: string;
  nextOpen: number | null;
  nextClose: number | null;
  moveBp: number | null;
  filledAt: string | null;
}

export interface OutcomeTarget {
  table: 'scorecard' | 'idea';
  id: string;
  underlying: string;
  at: Date;
}

const toScorecard = (r: {
  id: string; userId: string | null; symbol: string; exchange: string; underlying: string; side: string;
  window: string; computedAt: Date; factors: Prisma.JsonValue; total: number; band: string;
}): Scorecard => ({
  id: r.id,
  userId: r.userId,
  symbol: r.symbol,
  exchange: r.exchange,
  underlying: r.underlying,
  side: r.side as Scorecard['side'],
  window: r.window as ScoreWindow,
  computedAt: r.computedAt.toISOString(),
  factors: (Array.isArray(r.factors) ? r.factors : []) as unknown as FactorScore[],
  total: r.total,
  band: r.band as Scorecard['band'],
});

const SC_SELECT = {
  id: true, userId: true, symbol: true, exchange: true, underlying: true, side: true, window: true,
  computedAt: true, factors: true, total: true, band: true,
} as const;

/** Every DB read/write of the scorecard module. */
@Injectable()
export class ScorecardRepository {
  constructor(private readonly prisma: PrismaService) {}

  openTrackers(userId: string): Promise<TrackerLite[]> {
    return this.prisma.tradeTracker.findMany({
      where: { userId, status: 'OPEN' },
      select: { id: true, userId: true, symbol: true, exchange: true, kind: true, qty: true, status: true },
      orderBy: { entryTime: 'asc' },
    });
  }

  tracker(userId: string, trackerId: string): Promise<TrackerLite | null> {
    return this.prisma.tradeTracker.findFirst({
      where: { id: trackerId, userId },
      select: { id: true, userId: true, symbol: true, exchange: true, kind: true, qty: true, status: true },
    });
  }

  /** The `instruments.id` whose candles describe an underlying (index token, else the NSE cash line). */
  private async underlyingInstrumentId(name: string): Promise<string | null> {
    const idx = INDEX_UNDERLYINGS[name];
    if (idx) {
      const r = await this.prisma.instrument.findFirst({ where: { token: idx.token, exchange: idx.exchange }, select: { id: true } });
      return r?.id ?? null;
    }
    const rows = await this.prisma.instrument.findMany({
      where: { exchange: 'NSE', symbol: { in: [`${name}-EQ`, name] } },
      select: { id: true, symbol: true },
    });
    return (rows.find((r) => r.symbol === `${name}-EQ`) ?? rows[0])?.id ?? null;
  }

  /** Newest `limit` bars of `timeframe` ('1d' | '15m') from `candles`, oldest first. */
  async bars(name: string, timeframe: '1d' | '15m', limit: number, until?: Date): Promise<DailyBar[] | null> {
    const id = await this.underlyingInstrumentId(name);
    if (!id) return null;
    const rows = await this.prisma.candle.findMany({
      where: { instrumentId: id, timeframe, ...(until ? { timestamp: { lte: until } } : {}) },
      select: { timestamp: true, open: true, close: true },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
    return rows.reverse().map((r) => ({ day: istYmd(r.timestamp), open: r.open, close: r.close }));
  }

  /** Daily India VIX closes (last 1m close of each IST day) from mbm_bars_1m, oldest first. */
  async vixCloses(days: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<Array<{ close: number }>>(Prisma.sql`
      SELECT close FROM (
        SELECT DISTINCT ON ((ts AT TIME ZONE 'Asia/Kolkata')::date) (ts AT TIME ZONE 'Asia/Kolkata')::date AS d, close
        FROM mbm_bars_1m
        WHERE series = 'INDIAVIX' AND ts >= now() - make_interval(days => ${Math.ceil(days * 1.6) + 5})
        ORDER BY (ts AT TIME ZONE 'Asia/Kolkata')::date, ts DESC
      ) t ORDER BY d DESC LIMIT ${days}`);
    return rows.map((r) => Number(r.close)).reverse();
  }

  newsBetween(from: Date, to: Date, limit = 600): Promise<NewsRow[]> {
    return this.prisma.newsArticle.findMany({
      where: { publishedAt: { gte: from, lte: to } },
      select: {
        id: true, title: true, summary: true, source: true, url: true, category: true,
        sentiment: true, sentimentScore: true, relatedSymbols: true, instruments: true,
        sectors: true, indices: true, markets: true, publishedAt: true,
      },
      orderBy: { publishedAt: 'desc' },
      take: limit,
    });
  }

  async articleUrls(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.newsArticle.findMany({ where: { id: { in: ids } }, select: { id: true, url: true } });
    return new Map(rows.map((r) => [r.id, r.url]));
  }

  /** MBM daily setups that fired on `day` (IST 'YYYY-MM-DD') for `instrument`. */
  dailySetups(instrument: string, day: string): Promise<Array<{ setup: string; action: string }>> {
    return this.prisma.mbmDailySignal.findMany({
      where: { instrument, signalDate: new Date(`${day}T00:00:00.000Z`) },
      select: { setup: true, action: true },
    });
  }

  /** Underlying names with a live NFO contract (F&O-eligible) on/after `day`. */
  async fnoNames(day: string): Promise<Set<string>> {
    const rows = await this.prisma.instrument.findMany({
      where: { exchange: 'NFO', expiry: { gte: new Date(`${day}T00:00:00.000Z`) } },
      select: { name: true },
      distinct: ['name'],
    });
    return new Set(rows.map((r) => r.name.trim().toUpperCase()));
  }

  async ideaNewsIdsSince(since: Date): Promise<Set<string>> {
    const rows = await this.prisma.newsIdea.findMany({ where: { createdAt: { gte: since } }, select: { newsIds: true } });
    return new Set(rows.flatMap((r) => r.newsIds));
  }

  async insertScorecard(sc: Scorecard): Promise<string> {
    const r = await this.prisma.analysisScorecard.create({
      data: {
        userId: sc.userId, symbol: sc.symbol, exchange: sc.exchange, underlying: sc.underlying, side: sc.side,
        window: sc.window, computedAt: new Date(sc.computedAt), factors: sc.factors as unknown as Prisma.InputJsonValue,
        total: sc.total, band: sc.band,
      },
      select: { id: true },
    });
    return r.id;
  }

  /** One batch, all or nothing: the idea scorecards and their ideas. */
  async insertIdeas(items: ReadonlyArray<{ scorecard: Scorecard; idea: Omit<NewsIdea, 'id' | 'createdAt' | 'scorecardId'> }>, aiCallId: string | null): Promise<number> {
    await this.prisma.$transaction(async (tx) => {
      for (const { scorecard: sc, idea } of items) {
        const s = await tx.analysisScorecard.create({
          data: {
            userId: sc.userId, symbol: sc.symbol, exchange: sc.exchange, underlying: sc.underlying, side: sc.side,
            window: sc.window, computedAt: new Date(sc.computedAt), factors: sc.factors as unknown as Prisma.InputJsonValue,
            total: sc.total, band: sc.band,
          },
          select: { id: true },
        });
        await tx.newsIdea.create({
          data: {
            symbol: idea.symbol, exchange: idea.exchange, newsIds: idea.newsIds, headline: idea.headline, idea: idea.idea,
            rationale: idea.rationale, invalidation: idea.invalidation, whatToDo: idea.whatToDo, scorecardId: s.id, aiCallId,
          },
        });
      }
    });
    return items.length;
  }

  async latestScorecard(userId: string, symbol: string, exchange: string, windows: ScoreWindow[], since: Date): Promise<Scorecard | null> {
    const r = await this.prisma.analysisScorecard.findFirst({
      where: { userId, symbol, exchange, window: { in: windows }, computedAt: { gte: since } },
      orderBy: { computedAt: 'desc' },
      select: SC_SELECT,
    });
    return r ? toScorecard(r) : null;
  }

  async latestBySymbol(symbol: string, windows: ScoreWindow[], since: Date): Promise<Scorecard | null> {
    const r = await this.prisma.analysisScorecard.findFirst({
      where: { symbol, window: { in: windows }, computedAt: { gte: since } },
      orderBy: { computedAt: 'desc' },
      select: SC_SELECT,
    });
    return r ? toScorecard(r) : null;
  }

  async scorecardsByIds(ids: string[]): Promise<Map<string, Scorecard>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.analysisScorecard.findMany({ where: { id: { in: ids } }, select: SC_SELECT });
    return new Map(rows.map((r) => [r.id, toScorecard(r)]));
  }

  async ideasSince(since: Date, limit = 50): Promise<StoredIdea[]> {
    const rows = await this.prisma.newsIdea.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map((r) => ({
      id: r.id, createdAt: r.createdAt.toISOString(), symbol: r.symbol, exchange: r.exchange, newsIds: r.newsIds,
      headline: r.headline, idea: r.idea as NewsIdea['idea'], rationale: r.rationale, invalidation: r.invalidation,
      whatToDo: r.whatToDo, scorecardId: r.scorecardId, nextOpen: r.nextOpen, nextClose: r.nextClose, moveBp: r.moveBp,
      filledAt: r.filledAt ? r.filledAt.toISOString() : null,
    }));
  }

  /** Rows still waiting for an outcome, computed between `from` and `to`. */
  async unfilled(from: Date, to: Date): Promise<OutcomeTarget[]> {
    const [scs, ideas] = await Promise.all([
      this.prisma.analysisScorecard.findMany({
        where: { filledAt: null, computedAt: { gte: from, lte: to } },
        select: { id: true, underlying: true, computedAt: true },
        take: 500,
      }),
      this.prisma.newsIdea.findMany({
        where: { filledAt: null, createdAt: { gte: from, lte: to } },
        select: { id: true, symbol: true, createdAt: true },
        take: 200,
      }),
    ]);
    return [
      ...scs.map((r) => ({ table: 'scorecard' as const, id: r.id, underlying: r.underlying, at: r.computedAt })),
      ...ideas.map((r) => ({ table: 'idea' as const, id: r.id, underlying: r.symbol, at: r.createdAt })),
    ];
  }

  async fill(t: OutcomeTarget, o: { nextOpen: number; nextClose: number; moveBp: number }, at: Date): Promise<void> {
    const data = { nextOpen: o.nextOpen, nextClose: o.nextClose, moveBp: o.moveBp, filledAt: at };
    if (t.table === 'scorecard') await this.prisma.analysisScorecard.update({ where: { id: t.id }, data });
    else await this.prisma.newsIdea.update({ where: { id: t.id }, data });
  }
}
