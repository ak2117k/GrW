import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { NewsRow, VerdictRow } from '../domain/night-report.logic';

export interface TrackerRow {
  id: string;
  symbol: string;
  exchange: string;
  token: string;
  kind: string;
  qty: number;
  entryPrice: number;
  lastLtp: number | null;
  pnl: number | null;
  pnlPercent: number | null;
}

export interface EventRow {
  id: string;
  scope: string;
  kind: string;
  key: string;
  title: string;
  startsAt: Date;
  allDay: boolean;
  impact: string;
}

export interface DailySignalRow {
  instrument: string;
  signalDate: Date;
  setup: string;
  action: string;
  close: number;
  ret5dBp: number | null;
  ret10dBp: number | null;
  ret20dBp: number | null;
}

export interface DailyCandleFreshness {
  /** The newest daily bar's ts (IST midnight) across all instruments. */
  newest: Date | null;
  /** How many instruments have a bar at `day`. */
  countAtDay: number;
}

/** Everything the night report reads. A port so the aggregation is testable with fakes. */
export interface NightReportStore {
  openTrackers(userId: string): Promise<TrackerRow[]>;
  /** NSE cash tokens by underlying name (`NAME-EQ`, then `NAME`). Missing names are absent from the map. */
  cashTokens(names: string[]): Promise<Map<string, string>>;
  verdictsSince(userId: string, trackerIds: string[], since: Date): Promise<VerdictRow[]>;
  newsPublishedBetween(from: Date, to: Date, limit: number): Promise<NewsRow[]>;
  eventsBetween(from: Date, to: Date): Promise<EventRow[]>;
  dailySignalsOn(dates: Date[]): Promise<DailySignalRow[]>;
  newestNewsFetchedAt(): Promise<Date | null>;
  dailyCandles(day: Date): Promise<DailyCandleFreshness>;
  newestMbmPredictionAt(): Promise<Date | null>;
  newestMbmChainAt(): Promise<Date | null>;
  lastOvernightReviewAt(userId: string): Promise<Date | null>;
}

export const NIGHT_REPORT_STORE = Symbol('NIGHT_REPORT_STORE');

@Injectable()
export class NightReportRepository implements NightReportStore {
  constructor(private readonly prisma: PrismaService) {}

  openTrackers(userId: string): Promise<TrackerRow[]> {
    return this.prisma.tradeTracker.findMany({
      where: { userId, status: 'OPEN' },
      select: {
        id: true, symbol: true, exchange: true, token: true, kind: true, qty: true,
        entryPrice: true, lastLtp: true, pnl: true, pnlPercent: true,
      },
      orderBy: { entryTime: 'asc' },
    });
  }

  async cashTokens(names: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (names.length === 0) return out;
    const rows = await this.prisma.instrument.findMany({
      where: { exchange: 'NSE', symbol: { in: names.flatMap((n) => [`${n}-EQ`, n]) } },
      select: { symbol: true, token: true },
    });
    for (const n of names) {
      const hit = rows.find((r) => r.symbol === `${n}-EQ`) ?? rows.find((r) => r.symbol === n);
      if (hit) out.set(n, hit.token);
    }
    return out;
  }

  verdictsSince(userId: string, trackerIds: string[], since: Date): Promise<VerdictRow[]> {
    if (trackerIds.length === 0) return Promise.resolve([]);
    // `packet` and `evidence` are large; read only what the report shows.
    return this.prisma.sentinelVerdict.findMany({
      where: { userId, trackerId: { in: trackerIds }, createdAt: { gte: since } },
      select: {
        trackerId: true, verdict: true, confidence: true, reason: true,
        invalidationPoint: true, triggeredBy: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });
  }

  newsPublishedBetween(from: Date, to: Date, limit: number): Promise<NewsRow[]> {
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

  eventsBetween(from: Date, to: Date): Promise<EventRow[]> {
    return this.prisma.marketEvent.findMany({
      where: { startsAt: { gte: from, lt: to } },
      select: { id: true, scope: true, kind: true, key: true, title: true, startsAt: true, allDay: true, impact: true },
      orderBy: { startsAt: 'asc' },
    });
  }

  dailySignalsOn(dates: Date[]): Promise<DailySignalRow[]> {
    if (dates.length === 0) return Promise.resolve([]);
    return this.prisma.mbmDailySignal.findMany({
      where: { signalDate: { in: dates } },
      select: {
        instrument: true, signalDate: true, setup: true, action: true, close: true,
        ret5dBp: true, ret10dBp: true, ret20dBp: true,
      },
      orderBy: [{ signalDate: 'desc' }, { setup: 'asc' }],
    });
  }

  async newestNewsFetchedAt(): Promise<Date | null> {
    const r = await this.prisma.newsArticle.aggregate({ _max: { fetchedAt: true } });
    return r._max.fetchedAt ?? null;
  }

  async dailyCandles(day: Date): Promise<DailyCandleFreshness> {
    const [max, countAtDay] = await Promise.all([
      this.prisma.hubCandle1d.aggregate({ _max: { ts: true } }),
      this.prisma.hubCandle1d.count({ where: { ts: day } }),
    ]);
    return { newest: max._max.ts ?? null, countAtDay };
  }

  async newestMbmPredictionAt(): Promise<Date | null> {
    const r = await this.prisma.mbmPrediction.findFirst({ where: { instrument: 'NIFTY' }, orderBy: { asOf: 'desc' }, select: { asOf: true } });
    return r?.asOf ?? null;
  }

  async newestMbmChainAt(): Promise<Date | null> {
    const r = await this.prisma.mbmChainSnapshot.findFirst({ where: { instrument: 'NIFTY' }, orderBy: { capturedAt: 'desc' }, select: { capturedAt: true } });
    return r?.capturedAt ?? null;
  }

  async lastOvernightReviewAt(userId: string): Promise<Date | null> {
    const r = await this.prisma.sentinelVerdict.findFirst({
      where: { userId, triggeredBy: { array_contains: ['OVERNIGHT_REVIEW'] } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return r?.createdAt ?? null;
  }
}
