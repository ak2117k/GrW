import { Injectable, Logger } from '@nestjs/common';
import { PortfolioRepository } from '../repositories/portfolio.repository';
import type { PortfolioSummary } from '@td/shared';

export interface EquityPoint {
  date: string;
  equity: number;
}

export interface DailyPnLPoint {
  date: string;
  pnl: number;
}

export interface SegmentStats {
  segment: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
}

export interface StrategyStats {
  strategy: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
}

// ---- Chart-trade annotations (spec 2026-07-17-chart-trade-annotations-design §2) ----
// All `time` fields are epoch MILLISECONDS.
export interface ChartTradeExit {
  time: number;
  price: number;
  quantitySold: number;
  quantityRemaining: number; // cumulative: entryQty − running sold, clamped at 0
  reason: string | null;
}
export interface ChartTrade {
  tradeId: string;
  side: string; // "BUY" | "SELL" (position direction)
  provenance: string; // "Chartink (…)" | "Manual" | "Signal: …" | raw source
  entry: { time: number; price: number; quantity: number } | null;
  exits: ChartTradeExit[]; // sorted by time asc
}

/** TradeEvent.eventType values that represent a (partial or full) exit. */
const EXIT_EVENT_TYPES = new Set(['PARTIAL_EXIT', 'SL_HIT', 'TARGET_HIT', 'CLOSED']);

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(private readonly repo: PortfolioRepository) {}

  /**
   * Get aggregated portfolio summary
   */
  async getSummary(): Promise<PortfolioSummary> {
    const now = new Date();

    // Start of today
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    // Start of week (Monday)
    const startOfWeek = new Date(now);
    const day = startOfWeek.getDay();
    const diff = day === 0 ? 6 : day - 1;
    startOfWeek.setDate(startOfWeek.getDate() - diff);
    startOfWeek.setHours(0, 0, 0, 0);

    // Start of month
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [stats, todayPnl, weekPnl, monthPnl, openPositions] = await Promise.all([
      this.repo.getTradeStats(),
      this.repo.getTodayPnl(),
      this.repo.getPnlForRange(startOfWeek, now),
      this.repo.getPnlForRange(startOfMonth, now),
      this.repo.getOpenPositionCount(),
    ]);

    const winRate = stats.total > 0 ? (stats.wins / stats.total) * 100 : 0;

    // Compute max drawdown and Sharpe from daily performance
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 90);
    const dailyPerf = await this.repo.getDailyPerformanceRange(thirtyDaysAgo, now);

    let maxDrawdown = 0;
    let sharpeRatio = 0;

    if (dailyPerf.length > 0) {
      // Build equity curve for drawdown calculation
      const equityValues: number[] = [];
      let cumulative = 0;
      for (const dp of dailyPerf) {
        cumulative += dp.realizedPnl;
        equityValues.push(cumulative);
      }
      maxDrawdown = this.calculateMaxDrawdown(equityValues);

      // Sharpe from daily returns
      const dailyReturns = dailyPerf.map((dp) => dp.realizedPnl);
      sharpeRatio = this.calculateSharpeRatio(dailyReturns);
    }

    return {
      totalPnl: stats.totalPnl,
      todayPnl,
      weekPnl,
      monthPnl,
      winRate: Number(winRate.toFixed(2)),
      totalTrades: stats.total,
      openPositions,
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      sharpeRatio: Number(sharpeRatio.toFixed(2)),
    };
  }

  /**
   * Get equity curve data (cumulative P&L over time)
   */
  async getEquityCurve(from: Date, to: Date): Promise<EquityPoint[]> {
    const dailyPerf = await this.repo.getDailyPerformanceRange(from, to);

    let cumulative = 0;
    return dailyPerf.map((dp) => {
      cumulative += dp.realizedPnl;
      return {
        date: dp.date.toISOString().split('T')[0],
        equity: Number(cumulative.toFixed(2)),
      };
    });
  }

  /**
   * Get daily realized P&L for bar chart
   */
  async getDailyPnL(from: Date, to: Date): Promise<DailyPnLPoint[]> {
    const dailyPerf = await this.repo.getDailyPerformanceRange(from, to);

    return dailyPerf.map((dp) => ({
      date: dp.date.toISOString().split('T')[0],
      pnl: Number(dp.realizedPnl.toFixed(2)),
    }));
  }

  /**
   * Get P&L breakdown by segment
   */
  async getSegmentBreakdown(): Promise<SegmentStats[]> {
    return this.repo.getTradesBySegment();
  }

  /**
   * Get performance stats by strategy
   */
  async getStrategyPerformance(): Promise<StrategyStats[]> {
    return this.repo.getTradesByStrategy();
  }

  /**
   * Get paginated trade journal
   */
  async getTradeJournal(filters: {
    from?: Date;
    to?: Date;
    strategy?: string;
    segment?: string;
    status?: string;
    side?: string;
    vixRegime?: string;
    exitReasonTag?: string;
    page: number;
    limit: number;
    sortBy: string;
    order: 'asc' | 'desc';
  }) {
    return this.repo.getTradeJournal(filters);
  }

  /**
   * Get monthly performance report
   */
  async getMonthlyReport(year: number, month: number) {
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0, 23, 59, 59, 999);

    const [dailyPerf, segmentBreakdown, strategyPerformance] = await Promise.all([
      this.repo.getDailyPerformanceRange(from, to),
      this.getSegmentBreakdown(),
      this.getStrategyPerformance(),
    ]);

    const totalPnl = dailyPerf.reduce((sum, dp) => sum + dp.realizedPnl, 0);
    const totalTrades = dailyPerf.reduce((sum, dp) => sum + dp.totalTrades, 0);
    const winningTrades = dailyPerf.reduce((sum, dp) => sum + dp.winningTrades, 0);
    const losingTrades = dailyPerf.reduce((sum, dp) => sum + dp.losingTrades, 0);
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const tradingDays = dailyPerf.length;
    const profitDays = dailyPerf.filter((dp) => dp.realizedPnl > 0).length;
    const lossDays = dailyPerf.filter((dp) => dp.realizedPnl < 0).length;

    const equityValues: number[] = [];
    let cumulative = 0;
    for (const dp of dailyPerf) {
      cumulative += dp.realizedPnl;
      equityValues.push(cumulative);
    }
    const maxDrawdown = this.calculateMaxDrawdown(equityValues);
    const dailyReturns = dailyPerf.map((dp) => dp.realizedPnl);
    const sharpeRatio = this.calculateSharpeRatio(dailyReturns);

    return {
      year,
      month,
      totalPnl: Number(totalPnl.toFixed(2)),
      totalTrades,
      winningTrades,
      losingTrades,
      winRate: Number(winRate.toFixed(2)),
      tradingDays,
      profitDays,
      lossDays,
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      sharpeRatio: Number(sharpeRatio.toFixed(2)),
      segmentBreakdown,
      strategyPerformance,
    };
  }

  /**
   * Build chart-trade annotations for one instrument token: an entry marker and
   * an exit marker per sell, for the current user's trades on that instrument.
   * See docs/superpowers/specs/2026-07-17-chart-trade-annotations-design.md §2.
   */
  async getChartTrades(token: string): Promise<{ trades: ChartTrade[] }> {
    const trades = await this.repo.getTradesWithEventsByToken(token);
    return { trades: trades.map((trade) => this.toChartTrade(trade)) };
  }

  /** Shape one Trade (+ its events) into the fixed ChartTrade contract. */
  private toChartTrade(trade: any): ChartTrade {
    const events: any[] = trade.events ?? [];

    // --- entry: prefer the FILLED event, else fall back to Trade fields. ---
    const filled = events.find((e) => e.eventType === 'FILLED');
    const entryTime: Date | null = filled?.createdAt ?? trade.entryTime ?? null;
    const entryPrice: number | null = filled?.price ?? trade.entryPrice ?? null;
    // Base quantity for the running remaining maths (independent of whether a
    // renderable entry marker exists).
    const entryQty: number = filled?.quantity ?? trade.quantity ?? 0;

    const entry =
      entryTime != null && entryPrice != null
        ? { time: entryTime.getTime(), price: entryPrice, quantity: entryQty }
        : null;

    // --- exits: exit-type events sorted ascending, with cumulative remaining. ---
    const exitEvents = events
      .filter((e) => EXIT_EVENT_TYPES.has(e.eventType))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let cumulativeSold = 0;
    const exits: ChartTradeExit[] = exitEvents.map((e) => {
      const remainingBefore = Math.max(entryQty - cumulativeSold, 0);
      // A null event quantity (e.g. a CLOSED square-off) sells whatever remains.
      const quantitySold = e.quantity ?? remainingBefore;
      cumulativeSold += quantitySold;
      const quantityRemaining = Math.max(entryQty - cumulativeSold, 0);
      const reason =
        e.eventType === 'CLOSED' ? trade.exitReasonTag ?? e.eventType : e.eventType;
      return {
        time: e.createdAt.getTime(),
        price: e.price ?? trade.exitPrice ?? 0,
        quantitySold,
        quantityRemaining,
        reason,
      };
    });

    return {
      tradeId: trade.id,
      side: trade.side,
      provenance: this.deriveProvenance(trade.source, trade.strategy),
      entry,
      exits,
    };
  }

  /**
   * Derive a human-readable provenance from a trade's `source` + `strategy`
   * (v1 depth — deep Chartink scanner-name join is a fast-follow).
   */
  private deriveProvenance(source: string, strategy: string | null | undefined): string {
    const strat = strategy ?? '';
    if (
      (source === 'SCANNER' || source === 'AUTO') &&
      strat.toLowerCase().includes('chartink')
    ) {
      return `Chartink (${strategy})`;
    }
    if (source === 'MANUAL') return 'Manual';
    if (source === 'AUTO' && strategy) return `Signal: ${strategy}`;
    return source;
  }

  /**
   * Calculate Sharpe Ratio from daily returns
   * Assumes risk-free rate of 6% annualized (Indian T-Bill rate)
   */
  calculateSharpeRatio(dailyReturns: number[]): number {
    if (dailyReturns.length < 2) return 0;

    const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    // Daily risk-free rate: 6% annual / 252 trading days
    const dailyRiskFree = 0.06 / 252;

    // Annualize: multiply by sqrt(252)
    const sharpe = ((mean - dailyRiskFree) / stdDev) * Math.sqrt(252);

    return Number(sharpe.toFixed(2));
  }

  /**
   * Calculate maximum drawdown from an equity curve
   */
  calculateMaxDrawdown(equityCurve: number[]): number {
    if (equityCurve.length === 0) return 0;

    let peak = equityCurve[0];
    let maxDD = 0;

    for (const value of equityCurve) {
      if (value > peak) peak = value;
      const drawdown = peak - value;
      if (drawdown > maxDD) maxDD = drawdown;
    }

    return maxDD;
  }
}
