import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { MANUAL_VERDICT_PREFIX } from '../../sentinel-executor/domain/manual-exit';
import { OVERNIGHT_TAGS } from '../domain/scorers';

/**
 * Read-only access to the rows the scorers judge. Every query is bounded by a time range the run
 * service derives from session S; none of them writes.
 */
@Injectable()
export class VerificationSourcesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** analysis_scorecards with an outcome, computed in [from, to). */
  scorecards(from: Date, to: Date) {
    return this.prisma.analysisScorecard.findMany({
      where: { moveBp: { not: null }, computedAt: { gte: from, lt: to } },
      select: { id: true, symbol: true, underlying: true, side: true, window: true, computedAt: true, factors: true, total: true, band: true, moveBp: true },
      take: 2000,
    });
  }

  async scorecardTotals(ids: string[]): Promise<Array<{ id: string; total: number }>> {
    if (ids.length === 0) return [];
    return this.prisma.analysisScorecard.findMany({ where: { id: { in: ids } }, select: { id: true, total: true } });
  }

  /** Overnight / pre-open verdicts written in [from, to). */
  nightVerdicts(from: Date, to: Date) {
    return this.prisma.sentinelVerdict.findMany({
      where: {
        createdAt: { gte: from, lt: to },
        OR: OVERNIGHT_TAGS.map((t) => ({ triggeredBy: { array_contains: [t] } })),
      },
      select: { id: true, trackerId: true, symbol: true, verdict: true, confidence: true, createdAt: true, triggeredBy: true },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
  }

  async trackers(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.tradeTracker.findMany({
      where: { id: { in: ids } },
      select: { id: true, symbol: true, exchange: true, token: true, qty: true, status: true, exitPrice: true, exitTime: true },
    });
  }

  async bars1m(exchange: string, token: string, from: Date, to: Date): Promise<Array<{ ts: number; open: number; close: number }>> {
    const rows = await this.prisma.hubCandle1m.findMany({
      where: { exchange, token, ts: { gte: from, lt: to } },
      select: { ts: true, open: true, close: true },
      orderBy: { ts: 'asc' },
    });
    return rows.map((r) => ({ ts: r.ts.getTime(), open: Number(r.open), close: Number(r.close) }));
  }

  /**
   * An option's LTP from the chain snapshot captured nearest `at` (within ±20 min), or null. Strikes
   * JSON: [{strike, ce:{ltp…}, pe:{ltp…}}].
   */
  async chainLtp(instrument: string, expiry: string, strike: number, type: 'CE' | 'PE', at: Date): Promise<number | null> {
    const win = 20 * 60_000;
    const rows = await this.prisma.mbmChainSnapshot.findMany({
      where: { instrument, expiry: new Date(`${expiry}T00:00:00.000Z`), capturedAt: { gte: new Date(at.getTime() - win), lte: new Date(at.getTime() + win) } },
      select: { capturedAt: true, strikes: true },
      take: 20,
    });
    rows.sort((a, b) => Math.abs(a.capturedAt.getTime() - at.getTime()) - Math.abs(b.capturedAt.getTime() - at.getTime()));
    for (const r of rows) {
      if (!Array.isArray(r.strikes)) continue;
      const hit = (r.strikes as Array<Record<string, unknown>>).find((s) => Number(s?.strike) === strike);
      const leg = hit?.[type.toLowerCase()] as { ltp?: unknown } | null | undefined;
      const ltp = typeof leg?.ltp === 'number' ? leg.ltp : Number(leg?.ltp);
      if (Number.isFinite(ltp) && ltp > 0) return ltp;
    }
    return null;
  }

  /**
   * Executed AI exits (outcome kind EXECUTED = the executor's FILLED/PLACED rows; decisionPrice is
   * the fill) whose outcome is DONE, decided in [from, to). Read from ai_exit_outcomes only: the
   * executor's own table stays private to sentinel-executor (structure spec). The owner's manual
   * exits are not AI calls and are left out.
   */
  async liveExits(from: Date, to: Date) {
    const outcomes = await this.prisma.aiExitOutcome.findMany({
      where: { kind: 'EXECUTED', status: 'DONE', decisionAt: { gte: from, lt: to }, NOT: { verdictId: { startsWith: MANUAL_VERDICT_PREFIX } } },
      select: {
        executionId: true, verdictId: true, symbol: true, exchange: true, positionSide: true, qty: true,
        decisionPrice: true, decisionAt: true, closeAt60: true, closeAtEnd: true,
      },
      take: 500,
    });
    return outcomes;
  }

  newsIdeas(from: Date, to: Date) {
    return this.prisma.newsIdea.findMany({
      where: { moveBp: { not: null }, createdAt: { gte: from, lt: to } },
      select: { id: true, symbol: true, idea: true, headline: true, moveBp: true, createdAt: true, scorecardId: true, newsIds: true },
      take: 500,
    });
  }

  async articleSentiments(ids: string[]): Promise<Map<string, string | null>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.newsArticle.findMany({ where: { id: { in: ids } }, select: { id: true, sentiment: true } });
    return new Map(rows.map((r) => [r.id, r.sentiment ? r.sentiment.toLowerCase() : null]));
  }

  /** Average daily high−low range in bp over the `n` daily bars before `before`; null when < 5 bars. */
  async dailyRangeBp(name: string, before: Date, n = 14): Promise<number | null> {
    const idx = INDEX_UNDERLYINGS[name];
    const inst = idx
      ? await this.prisma.instrument.findFirst({ where: { token: idx.token, exchange: idx.exchange }, select: { id: true } })
      : (await this.prisma.instrument.findMany({ where: { exchange: 'NSE', symbol: { in: [`${name}-EQ`, name] } }, select: { id: true, symbol: true } }))
          .sort((a, b) => (a.symbol === `${name}-EQ` ? -1 : b.symbol === `${name}-EQ` ? 1 : 0))[0];
    if (!inst) return null;
    const bars = await this.prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: '1d', timestamp: { lt: before } },
      select: { high: true, low: true, close: true },
      orderBy: { timestamp: 'desc' },
      take: n,
    });
    const ranges = bars.filter((b) => b.close > 0 && b.high >= b.low).map((b) => ((b.high - b.low) / b.close) * 1e4);
    if (ranges.length < 5) return null;
    return Math.round((ranges.reduce((s, x) => s + x, 0) / ranges.length) * 10) / 10;
  }

  async mbmPredictions(from: Date, to: Date) {
    const rows = await this.prisma.mbmPrediction.findMany({
      where: { outcomeBig: { not: null }, asOf: { gte: from, lt: to } },
      select: { id: true, instrument: true, horizon: true, asOf: true, p: true, regime: true, outcomeBig: true, outcomeQuality: true, outcomeRangeBp: true, outcomeThresholdBp: true },
      take: 2000,
    });
    return rows.map((r) => ({ ...r, id: String(r.id), outcomeBig: r.outcomeBig === true }));
  }
}
