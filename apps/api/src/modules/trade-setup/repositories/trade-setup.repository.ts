import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ScorecardRepository } from '../../overnight-scorecard/scorecard.repository';
import type { FactorScore } from '../../overnight-scorecard/scorecard.types';
import { STOCK_MOVE_HORIZON_DAYS, STOCK_MOVE_THRESHOLD_ATR } from '../../stock-move/stock-move.logic';
import type { IntradayBar, SetupOutcome, TradeSetupDraft } from '../domain/trade-setup.logic';

export interface IdeaRow {
  id: string;
  createdAt: Date;
  symbol: string;
  exchange: string;
  idea: string;
  headline: string;
  scorecardId: string | null;
}

export interface StockBookRow {
  asOf: Date;
  symbol: string;
  pBig: number;
  rankPct: number;
  bucket: string;
  resultsDate: Date | null;
  resultsInWindow: boolean;
  atrPct: number | null;
  close: number | null;
  modelId: string;
}

export interface DailyHlc {
  day: Date;
  high: number;
  low: number;
  close: number;
}

/** A stored setup as the night report and the outcome job read it. */
export type StoredSetup = Prisma.TradeSetupGetPayload<Record<string, never>>;

/**
 * Every DB read / write of the trade-setup module. Writes only `trade_setups` and
 * `account_margin_snapshots`; never an order, a paper trade or a tracker.
 */
@Injectable()
export class TradeSetupRepository {
  constructor(
    private readonly prisma: PrismaService,
    /** Reused for the underlying → instrument lookup and the India VIX closes. */
    private readonly scorecards: ScorecardRepository,
  ) {}

  ideasSince(since: Date): Promise<IdeaRow[]> {
    return this.prisma.newsIdea.findMany({
      where: { createdAt: { gte: since } },
      select: { id: true, createdAt: true, symbol: true, exchange: true, idea: true, headline: true, scorecardId: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async scorecardFactors(ids: string[]): Promise<Map<string, FactorScore[]>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.analysisScorecard.findMany({ where: { id: { in: ids } }, select: { id: true, factors: true } });
    return new Map(rows.map((r) => [r.id, (Array.isArray(r.factors) ? r.factors : []) as unknown as FactorScore[]]));
  }

  /** Every row of the newest stock big-move book dated on/after `since`. */
  async latestStockBook(since: Date): Promise<StockBookRow[]> {
    const key = { horizonDays: STOCK_MOVE_HORIZON_DAYS, thresholdAtr: STOCK_MOVE_THRESHOLD_ATR };
    const newest = await this.prisma.stockMoveScore.findFirst({ where: { ...key, asOf: { gte: since } }, orderBy: { asOf: 'desc' }, select: { asOf: true } });
    if (!newest) return [];
    return this.prisma.stockMoveScore.findMany({
      where: { ...key, asOf: newest.asOf },
      select: { asOf: true, symbol: true, pBig: true, rankPct: true, bucket: true, resultsDate: true, resultsInWindow: true, atrPct: true, close: true, modelId: true },
      take: 1000,
    });
  }

  /** The regimes of the newest stored MBM predictions for `instrument` (rows within 12 h of the newest, younger than maxAgeMs). */
  async mbmRegimes(instrument: string, now: Date, maxAgeMs: number): Promise<{ asOf: Date; regimes: Record<string, string> } | null> {
    const stored = await this.scorecards.storedMood(instrument, now, maxAgeMs);
    if (!stored) return null;
    return { asOf: stored.asOf, regimes: Object.fromEntries(Object.entries(stored.horizons).map(([h, v]) => [h, v.regime])) };
  }

  /** Newest `limit` daily bars (high/low/close) of an underlying from `candles`, oldest first; null when it has no instrument. */
  async dailyBars(name: string, limit: number): Promise<DailyHlc[] | null> {
    const inst = await this.scorecards.underlyingInstrument(name);
    if (!inst) return null;
    const rows = await this.prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: '1d' },
      select: { timestamp: true, high: true, low: true, close: true },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
    return rows.reverse().map((r) => ({ day: r.timestamp, high: r.high, low: r.low, close: r.close }));
  }

  /** 15-min bars of an underlying in [from, to), oldest first. */
  async bars15m(name: string, from: Date, to: Date): Promise<IntradayBar[]> {
    const inst = await this.scorecards.underlyingInstrument(name);
    if (!inst) return [];
    const rows = await this.prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: '15m', timestamp: { gte: from, lt: to } },
      select: { timestamp: true, open: true, high: true, low: true, close: true },
      orderBy: { timestamp: 'asc' },
    });
    return rows.map((r) => ({ ts: r.timestamp.getTime(), open: r.open, high: r.high, low: r.low, close: r.close }));
  }

  vixCloses(days: number): Promise<number[]> {
    return this.scorecards.vixCloses(days);
  }

  underlyingInstrument(name: string) {
    return this.scorecards.underlyingInstrument(name);
  }

  /** Futures contracts of an underlying from the `instruments` table (fallback when the broker master is unreachable). */
  async futuresFromTable(name: string, from: Date): Promise<Array<{ symbol: string; token: string; expiry: Date | null; lotSize: number }>> {
    return this.prisma.instrument.findMany({
      where: { exchange: 'NFO', name, expiry: { gte: from }, optionType: null, symbol: { endsWith: 'FUT' } },
      select: { symbol: true, token: true, expiry: true, lotSize: true },
      orderBy: { expiry: 'asc' },
      take: 6,
    });
  }

  latestMargin(userId: string): Promise<{ asOf: Date; availableCash: number } | null> {
    return this.prisma.accountMarginSnapshot.findFirst({ where: { userId }, orderBy: { asOf: 'desc' }, select: { asOf: true, availableCash: true } });
  }

  async saveMargin(userId: string, availableCash: number, net: number | null): Promise<void> {
    await this.prisma.accountMarginSnapshot.create({ data: { userId, availableCash, net } });
  }

  /** Upsert by (session, symbol); a re-run (the morning batch) replaces the plan, never the outcome. */
  async upsert(userId: string, d: TradeSetupDraft): Promise<void> {
    const data = {
      exchange: d.exchange,
      instrument: d.instrument,
      instrumentKind: d.instrumentKind,
      instrumentToken: d.instrumentToken,
      expiry: d.expiry,
      lotSize: d.lotSize,
      side: d.side,
      newsIdeaId: d.newsIdeaId,
      entryRule: d.entryRule,
      entryRef: d.entryRef,
      stop: d.stop,
      stopDistance: d.stopDistance,
      target1: d.target1,
      target2: d.target2,
      atr: d.atr,
      qty: d.qty,
      lots: d.lots,
      riskRs: d.riskRs,
      riskPct: d.riskPct,
      rewardT1Rs: d.rewardT1Rs,
      rewardT2Rs: d.rewardT2Rs,
      marginUsed: d.marginUsed,
      marginAvailable: d.marginAvailable,
      marginAsOf: d.marginAsOf ? new Date(d.marginAsOf) : null,
      marginSource: d.marginSource,
      exceedsRisk: d.exceedsRisk,
      inputs: d.inputs as unknown as Prisma.InputJsonValue,
    };
    await this.prisma.tradeSetup.upsert({
      where: { userId_sessionDate_symbol: { userId, sessionDate: d.sessionDate, symbol: d.symbol } },
      create: { userId, sessionDate: d.sessionDate, symbol: d.symbol, ...data },
      update: data,
    });
  }

  /** One user's setups for a session: rows are sized on that user's margin and never shown to anyone else. */
  forSession(userId: string, sessionDate: string): Promise<StoredSetup[]> {
    return this.prisma.tradeSetup.findMany({ where: { userId, sessionDate }, orderBy: [{ exceedsRisk: 'asc' }, { createdAt: 'asc' }], take: 50 });
  }

  /** Setups whose session is in [fromSession, toSession] with no outcome yet. */
  unfilled(fromSession: string, toSession: string): Promise<StoredSetup[]> {
    return this.prisma.tradeSetup.findMany({ where: { filledAt: null, sessionDate: { gte: fromSession, lte: toSession } }, take: 200 });
  }

  async fill(id: string, o: SetupOutcome, at: Date): Promise<void> {
    await this.prisma.tradeSetup.update({
      where: { id },
      data: {
        outcomeStatus: o.status,
        outcomeEntryAt: o.entryAt != null ? new Date(o.entryAt) : null,
        outcomeEntryPrice: o.entryPrice,
        outcomeExitPrice: o.exitPrice,
        outcomeR: o.r,
        outcomeHitT1: o.hitT1,
        outcomeDetails: o.details as Prisma.InputJsonValue,
        filledAt: at,
      },
    });
  }
}
