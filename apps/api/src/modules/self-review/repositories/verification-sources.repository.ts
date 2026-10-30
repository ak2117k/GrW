import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { MANUAL_VERDICT_PREFIX } from '../../sentinel-executor/domain/manual-exit';
import { OVERNIGHT_TAGS } from '../domain/scorers';
import { STOCK_MOVE_HORIZON_DAYS, STOCK_MOVE_THRESHOLD_ATR } from '../../stock-move/stock-move.logic';
import { SIGNAL_PAPER_STRATEGY, decisionIdFromTags } from '../../signal-trader/domain/paper';
import { oiVerdictOf } from '../../signal-trader/domain/oi-check';
import { judgeCallOf } from '../../signal-trader/domain/paper-summary';
import { asInfoItems } from '../../signal-intake/domain/info';
import { noiseVerdictOfRecord } from '../../exit-noise/domain/noise-read';
import type { ExitNoiseReadRow } from '../domain/exit-noise';
import type { EngineDecisionRow, EngineTradeRow } from '../domain/engine-trades';

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
      select: {
        id: true, instrument: true, horizon: true, asOf: true, p: true, regime: true, outcomeBig: true, outcomeQuality: true, outcomeRangeBp: true, outcomeThresholdBp: true,
        q50Bp: true, relRatio: true, relLabel: true, refRangeBp: true,
      },
      take: 2000,
    });
    return rows.map((r) => ({ ...r, id: String(r.id), outcomeBig: r.outcomeBig === true }));
  }

  /** Resolved stock big-move rows scored on `asOf` (IST 'YYYY-MM-DD'; a DATE column, read as UTC midnight). */
  async stockMoves(asOf: string) {
    const rows = await this.prisma.stockMoveScore.findMany({
      where: {
        asOf: new Date(`${asOf}T00:00:00.000Z`),
        horizonDays: STOCK_MOVE_HORIZON_DAYS,
        thresholdAtr: STOCK_MOVE_THRESHOLD_ATR,
        outcomeBig: { not: null },
      },
      select: {
        id: true, symbol: true, asOf: true, horizonDays: true, pBig: true, rankPct: true, bucket: true,
        resultsInWindow: true, modelId: true, outcomeBig: true, outcomeRetBp: true,
      },
      take: 1000,
    });
    return rows.map((r) => ({ ...r, id: String(r.id), outcomeBig: r.outcomeBig === true }));
  }

  /** Trade setups for session `session` (IST 'YYYY-MM-DD') whose outcome has been filled. */
  async tradeSetups(session: string) {
    const rows = await this.prisma.tradeSetup.findMany({
      where: { sessionDate: session, filledAt: { not: null }, outcomeStatus: { not: null } },
      select: {
        id: true, sessionDate: true, symbol: true, side: true, instrument: true, entryRef: true, stopDistance: true,
        outcomeStatus: true, outcomeR: true, outcomeHitT1: true, outcomeEntryPrice: true, outcomeExitPrice: true,
        entryRule: true, atr: true, newsIdeaId: true,
      },
      take: 200,
    });
    // The news idea each setup was built from: what the diagnosis needs to say WHY a setup missed.
    const ideaIds = [...new Set(rows.map((r) => r.newsIdeaId).filter((x): x is string => !!x))];
    const ideas = ideaIds.length
      ? await this.prisma.newsIdea.findMany({ where: { id: { in: ideaIds } }, select: { id: true, headline: true, idea: true, rationale: true, invalidation: true } })
      : [];
    const byId = new Map(ideas.map((i) => [i.id, i]));
    return rows.map(({ newsIdeaId, ...r }) => {
      const i = newsIdeaId ? byId.get(newsIdeaId) : undefined;
      return { ...r, outcomeStatus: r.outcomeStatus as string, newsIdea: i ? { headline: i.headline, idea: i.idea, rationale: i.rationale, invalidation: i.invalidation } : null };
    });
  }

  /** Telegram signal trades opened in [from, to): PAPER (no funds) Trade rows and live SignalOrders + trackers. */
  async signalTradeOutcomes(from: Date, to: Date) {
    const [paper, orders] = await Promise.all([
      this.prisma.trade.findMany({
        where: { strategy: SIGNAL_PAPER_STRATEGY, isPaperTrade: true, createdAt: { gte: from, lt: to } },
        select: { createdAt: true, status: true, pnl: true, side: true, quantity: true, entryPrice: true, exitPrice: true, entryTags: true, instrument: { select: { symbol: true } } },
        take: 2000,
      }),
      this.prisma.signalOrder.findMany({ where: { createdAt: { gte: from, lt: to } }, select: { createdAt: true, status: true, trackerId: true }, take: 2000 }),
    ]);
    const ids = [...new Set(orders.map((o) => o.trackerId).filter((x): x is string => !!x))];
    const trackers = ids.length ? await this.prisma.tradeTracker.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, pnl: true } }) : [];
    const byId = new Map(trackers.map((t) => [t.id, t]));
    // Each paper trade's OI check at entry (signal_decisions.oi_check, record only) and AI entry judge call,
    // for the splits by OI verdict / judge the diagnosis reasons over.
    const decisionIds = [...new Set(paper.map((p) => decisionIdFromTags(p.entryTags)).filter((x): x is string => !!x))];
    const decisions = decisionIds.length ? await this.prisma.signalDecision.findMany({ where: { id: { in: decisionIds } }, select: { id: true, oiCheck: true, judge: true } }) : [];
    const byDecision = new Map(decisions.map((d) => [d.id, d]));
    return {
      paper: paper.map(({ entryTags, instrument, ...p }) => {
        const d = byDecision.get(decisionIdFromTags(entryTags) ?? '');
        const summary = (d?.oiCheck as { summary?: unknown } | null | undefined)?.summary;
        return {
          ...p,
          symbol: instrument?.symbol ?? null,
          oiVerdict: d ? oiVerdictOf(d.oiCheck) : ('NO_DATA' as const),
          oiSummary: typeof summary === 'string' ? summary : null,
          aiDecision: d ? judgeCallOf(d.judge) : ('NONE' as const),
        };
      }),
      live: orders.map((o) => {
        const t = o.trackerId ? byId.get(o.trackerId) : undefined;
        return { createdAt: o.createdAt, status: o.status, trackerStatus: t ? String(t.status) : null, pnl: t?.pnl ?? null };
      }),
    };
  }

  /**
   * The entry engine in [from, to): its recorded decisions (entry_engine_decisions, raw SQL so this
   * module does not depend on the table at compile time; [] when absent — migration 20261030160000 not
   * applied) and its ENGINE_ENTRY paper trades. Observation only.
   */
  async engineReview(from: Date, to: Date): Promise<{ decisions: EngineDecisionRow[]; trades: EngineTradeRow[] }> {
    let decisions: EngineDecisionRow[] = [];
    try {
      const rows = await this.prisma.$queryRaw<Array<{ at: Date; underlying: string; action: string; mode: string; trade_id: string | null; reasons: unknown }>>`
        SELECT at, underlying, action, mode, trade_id, reasons FROM "entry_engine_decisions" WHERE at >= ${from} AND at < ${to} ORDER BY at LIMIT 5000`;
      decisions = rows.map((r) => ({
        at: r.at,
        underlying: String(r.underlying),
        action: String(r.action),
        mode: String(r.mode),
        tradeId: r.trade_id ?? null,
        reasons: Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === 'string') : [],
      }));
    } catch {
      decisions = [];
    }
    const trades = await this.prisma.trade.findMany({
      where: { strategy: 'ENGINE_ENTRY', isPaperTrade: true, createdAt: { gte: from, lt: to } },
      select: { id: true, createdAt: true, status: true, side: true, quantity: true, entryPrice: true, exitPrice: true, exitReasonTag: true, entryTags: true, instrument: { select: { symbol: true } } },
      take: 2000,
    });
    return {
      decisions,
      trades: trades.map((t) => ({
        id: t.id,
        createdAt: t.createdAt,
        underlying: (t.entryTags ?? []).find((x) => x.startsWith('underlying:'))?.slice('underlying:'.length) ?? null,
        symbol: t.instrument?.symbol ?? null,
        status: String(t.status),
        side: t.side ? String(t.side) : null,
        quantity: t.quantity ?? null,
        entryPrice: t.entryPrice ?? null,
        exitPrice: t.exitPrice ?? null,
        exitReasonTag: t.exitReasonTag ?? null,
      })),
    };
  }

  /**
   * The "noise or real?" reads taken at AI exits in [from, to) (exit_noise_reads, record only), with
   * their follow-up. Raw SQL so this module does not depend on the table at compile time; [] when the
   * table is absent (migration 20261030120000 not applied).
   */
  async exitNoiseReads(from: Date, to: Date): Promise<ExitNoiseReadRow[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT source, symbol, exit_rule, want, verdict, exit_at, underlying_at_exit, noise_n, underlying_after_15m, underlying_after_30m,
          max_favour_30m, max_against_30m, followed_at, read->>'summary' AS summary
        FROM "exit_noise_reads" WHERE exit_at >= ${from} AND exit_at < ${to} ORDER BY exit_at LIMIT 2000`;
      const n = (v: unknown) => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
      return rows.map((r) => ({
        source: String(r.source),
        symbol: String(r.symbol),
        exitRule: String(r.exit_rule),
        want: r.want === 'BEARISH' ? 'BEARISH' : 'BULLISH',
        verdict: noiseVerdictOfRecord(r.verdict),
        exitAt: r.exit_at as Date,
        underlyingAtExit: n(r.underlying_at_exit),
        n: n(r.noise_n),
        after15m: n(r.underlying_after_15m),
        after30m: n(r.underlying_after_30m),
        maxFavour30m: n(r.max_favour_30m),
        maxAgainst30m: n(r.max_against_30m),
        followed: r.followed_at !== null && r.followed_at !== undefined,
        summary: typeof r.summary === 'string' ? r.summary : null,
      }));
    } catch {
      return [];
    }
  }

  /** Telegram INFO rows whose outcome is scored on `session` (signal-intake fills it at 16:20 IST). */
  async channelInfos(session: string) {
    const rows = await this.prisma.channelInfo.findMany({
      where: { outcomeSession: session, outcomeFilledAt: { not: null } },
      select: { id: true, channelId: true, messageId: true, extractor: true, items: true, outcomes: true, outcomeSession: true },
      take: 2000,
    });
    return rows.map((r) => ({
      id: r.id,
      sessionDate: r.outcomeSession as string,
      channelId: r.channelId,
      messageId: r.messageId,
      extractor: r.extractor,
      items: asInfoItems(r.items),
      outcomes: Array.isArray(r.outcomes) ? (r.outcomes as Array<{ status: string; session: string | null; ret: number | null; band: number | null; levelHit: boolean | null } | null>) : [],
    }));
  }

  /** Telegram channel signals whose outcome is scored on `session` (signal-intake fills it at 16:20 IST). */
  async channelSignals(session: string) {
    const rows = await this.prisma.tradeSignal.findMany({
      where: { outcomeSession: session, outcomeFilledAt: { not: null }, outcomeStatus: { not: null } },
      select: {
        id: true, channelId: true, underlying: true, instrumentKind: true, strike: true, side: true, entryType: true,
        entryLow: true, entryHigh: true, sl: true, targets: true, horizon: true, parser: true, outcomeStatus: true, outcomeSession: true,
      },
      take: 1000,
    });
    return rows.map(({ outcomeSession, targets, ...r }) => ({
      ...r,
      sessionDate: outcomeSession as string,
      outcomeStatus: r.outcomeStatus as string,
      targets: Array.isArray(targets) ? (targets as unknown[]).map(Number).filter((x) => Number.isFinite(x)) : [],
    }));
  }
}
