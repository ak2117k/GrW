import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  computeByDay,
  computeByFactor,
  computeByScanner,
  computeByScoreBucket,
  computeRealized,
  computeSummary,
  type DayRow,
  type FactorCheck,
  type FactorRow,
  type RealizedStats,
  type ScannerRow,
  type ScoreBucketRow,
  type StatTrade,
  type StatWatch,
  type StrategyReviewSummary,
} from '../strategy-review.stats';

/**
 * Full response contract for GET /api/strategy-review.
 *
 * The review is re-based on WatchEntry rows — every watched Chartink alert
 * is a data point, giving a real sample (~105/day) instead of the handful
 * that became trades. `summary` is the watch-outcome view; `realized` is
 * the executed-paper-trade (real-money) view, kept deliberately separate.
 */
export interface StrategyReview {
  range: { from: string | null; to: string | null };
  summary: StrategyReviewSummary;
  realized: RealizedStats;
  byScanner: ScannerRow[];
  byScoreBucket: ScoreBucketRow[];
  byFactor: FactorRow[];
  byDay: DayRow[];
  sampleWarning: string | null;
}

/** Below this many resolved watch entries, breakdowns are statistically noise. */
const MIN_SAMPLE = 30;

@Injectable()
export class StrategyReviewService {
  private readonly logger = new Logger(StrategyReviewService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregate watched Chartink alerts into strategy-improvement metrics.
   * `from`/`to` are optional YYYY-MM-DD strings filtering WatchEntry.initialAt
   * (interpreted as IST calendar days). Default = all data.
   */
  async getReview(from?: string, to?: string): Promise<StrategyReview> {
    const range = this.resolveRange(from, to);

    // ---- Watch entries: every watched Chartink alert in range. ----
    const watchWhere: Prisma.WatchEntryWhereInput = {};
    if (range.start || range.end) {
      watchWhere.initialAt = {};
      if (range.start) watchWhere.initialAt.gte = range.start;
      if (range.end) watchWhere.initialAt.lte = range.end;
    }
    const watchRows = await this.prisma.watchEntry.findMany({
      where: watchWhere,
      select: {
        id: true,
        side: true,
        status: true,
        initialScore: true,
        initialPrice: true,
        initialBreakdown: true,
        initialAt: true,
        maxFavorable: true,
        maxAdverse: true,
        paperTradeId: true,
        alertId: true,
      },
    });

    // ---- Resolve alertId -> scanner name in one batched query. ----
    // WatchEntry.alertId -> ChartinkAlert.scannerId -> ChartinkScanner.scanName.
    const alertIds = [
      ...new Set(
        watchRows
          .map((w) => w.alertId)
          .filter((x): x is string => typeof x === 'string'),
      ),
    ];
    const scannerByAlert = new Map<string, string>();
    if (alertIds.length > 0) {
      const chartinkAlerts = await this.prisma.chartinkAlert.findMany({
        where: { id: { in: alertIds } },
        select: { id: true, scanner: { select: { scanName: true } } },
      });
      for (const a of chartinkAlerts) {
        scannerByAlert.set(a.id, a.scanner.scanName);
      }
    }

    const watches: StatWatch[] = watchRows.map((w) => ({
      id: w.id,
      scanner: w.alertId ? scannerByAlert.get(w.alertId) ?? null : null,
      side: w.side,
      status: w.status,
      initialScore: w.initialScore,
      initialPrice: w.initialPrice,
      maxFavorable: w.maxFavorable,
      maxAdverse: w.maxAdverse,
      initialAt: w.initialAt,
      paperTradeId: w.paperTradeId,
      checks: this.extractChecks(w.initialBreakdown),
    }));

    // ---- Trades: the paper Trades these watches were executed into. ----
    // Only Trade rows linked from a watch's paperTradeId are relevant — the
    // `realized` block reports real-money P&L for the executed subset.
    const tradeIds = [
      ...new Set(
        watches
          .map((w) => w.paperTradeId)
          .filter((x): x is string => typeof x === 'string'),
      ),
    ];
    let trades: StatTrade[] = [];
    if (tradeIds.length > 0) {
      const tradeRows = await this.prisma.trade.findMany({
        where: { id: { in: tradeIds } },
        select: {
          id: true,
          status: true,
          pnl: true,
          fees: true,
          entryTime: true,
        },
      });
      trades = tradeRows.map((t) => ({
        id: t.id,
        status: t.status,
        pnl: t.pnl,
        fees: t.fees,
        entryTime: t.entryTime,
      }));
    }

    // ---- Pure aggregation. ----
    const summary = computeSummary(watches);
    const realized = computeRealized(watches, trades);
    const byScanner = computeByScanner(watches);
    const byScoreBucket = computeByScoreBucket(watches);
    const byFactor = computeByFactor(watches);
    const byDay = computeByDay(watches, trades);

    const sampleWarning =
      summary.resolved < MIN_SAMPLE
        ? `Only ${summary.resolved} resolved watch entries — treat breakdowns as noise until ${MIN_SAMPLE}+.`
        : null;

    return {
      range: { from: range.from, to: range.to },
      summary,
      realized,
      byScanner,
      byScoreBucket,
      byFactor,
      byDay,
      sampleWarning,
    };
  }

  /**
   * Parse optional YYYY-MM-DD params into UTC instants. `from` is the start
   * of that IST day, `to` is the end of that IST day, so the range is
   * inclusive of both calendar days as the user sees them.
   */
  private resolveRange(
    from?: string,
    to?: string,
  ): {
    from: string | null;
    to: string | null;
    start: Date | null;
    end: Date | null;
  } {
    const valid = (d?: string): boolean =>
      !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const f = valid(from) ? (from as string) : null;
    const t = valid(to) ? (to as string) : null;
    return {
      from: f,
      to: t,
      start: f ? new Date(`${f}T00:00:00.000+05:30`) : null,
      end: t ? new Date(`${t}T23:59:59.999+05:30`) : null,
    };
  }

  /**
   * Pull the factor checks out of WatchEntry.initialBreakdown. Expected shape
   * is `{ checks: [{name, passed}], lotCount }` but the column is free-form
   * Json, so guard every access and silently drop malformed entries.
   */
  private extractChecks(breakdown: Prisma.JsonValue | null): FactorCheck[] {
    if (
      !breakdown ||
      typeof breakdown !== 'object' ||
      Array.isArray(breakdown)
    ) {
      return [];
    }
    const checks = (breakdown as Record<string, unknown>).checks;
    if (!Array.isArray(checks)) return [];
    const out: FactorCheck[] = [];
    for (const c of checks) {
      if (
        c &&
        typeof c === 'object' &&
        typeof (c as Record<string, unknown>).name === 'string' &&
        typeof (c as Record<string, unknown>).passed === 'boolean'
      ) {
        out.push({
          name: (c as Record<string, unknown>).name as string,
          passed: (c as Record<string, unknown>).passed as boolean,
        });
      }
    }
    return out;
  }
}
