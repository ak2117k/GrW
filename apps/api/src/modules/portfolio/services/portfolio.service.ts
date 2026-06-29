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
