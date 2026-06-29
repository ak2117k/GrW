import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SYSTEM_USER_ID } from '../../../common/tenant/tenant.constants';
import { firstValueFrom } from 'rxjs';

export interface WeeklyReport {
  id: string;
  weekStart: Date;
  weekEnd: Date;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  overallScore: number;
  createdAt: Date;
}

@Injectable()
export class WeeklyReportService {
  private readonly logger = new Logger(WeeklyReportService.name);
  private readonly aiEngineUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.aiEngineUrl =
      this.configService.get<string>('AI_ENGINE_URL') ||
      'http://localhost:8000';
  }

  /**
   * Runs every Sunday at 23:00 IST to generate the weekly report
   */
  @Cron('0 23 * * 0', { timeZone: 'Asia/Kolkata' })
  async handleWeeklyReportCron() {
    this.logger.log('Weekly report cron triggered');
    try {
      await this.generateWeeklyReport();
    } catch (error) {
      this.logger.error('Weekly report cron failed', error);
    }
  }

  /**
   * Generate comprehensive weekly performance report
   */
  async generateWeeklyReport(): Promise<WeeklyReport> {
    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setHours(23, 59, 59, 999);

    const weekStart = new Date(now);
    const day = weekStart.getDay();
    const diff = day === 0 ? 6 : day - 1;
    weekStart.setDate(weekStart.getDate() - diff);
    weekStart.setHours(0, 0, 0, 0);

    this.logger.log(
      `Generating report for ${weekStart.toISOString()} to ${weekEnd.toISOString()}`,
    );

    // Fetch all closed trades this week
    const trades = await this.prisma.trade.findMany({
      where: {
        status: 'CLOSED',
        createdAt: { gte: weekStart, lte: weekEnd },
      },
      include: { instrument: true },
      orderBy: { createdAt: 'asc' },
    });

    // Compute metrics
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
    const losses = trades.filter((t) => (t.pnl ?? 0) <= 0);
    const winRate =
      trades.length > 0
        ? Math.round((wins.length / trades.length) * 100)
        : 0;

    // Best and worst trades
    const sortedByPnl = [...trades].sort(
      (a, b) => (b.pnl ?? 0) - (a.pnl ?? 0),
    );
    const bestTrade = sortedByPnl[0] ?? null;
    const worstTrade = sortedByPnl[sortedByPnl.length - 1] ?? null;

    // Strategy breakdown
    const stratMap = new Map<
      string,
      { wins: number; losses: number; pnl: number }
    >();
    for (const t of trades) {
      const strat = t.strategy ?? 'unknown';
      const cur = stratMap.get(strat) ?? { wins: 0, losses: 0, pnl: 0 };
      if ((t.pnl ?? 0) > 0) cur.wins++;
      else cur.losses++;
      cur.pnl += t.pnl ?? 0;
      stratMap.set(strat, cur);
    }

    // Build summary
    const summaryParts: string[] = [];
    summaryParts.push(
      `Weekly Summary: ${trades.length} trades closed, ${wins.length} wins, ${losses.length} losses.`,
    );
    summaryParts.push(
      `Total P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} | Win Rate: ${winRate}%.`,
    );
    if (bestTrade) {
      summaryParts.push(
        `Best trade: ${bestTrade.instrument?.symbol ?? 'N/A'} (${(bestTrade.pnl ?? 0) >= 0 ? '+' : ''}${(bestTrade.pnl ?? 0).toFixed(2)}).`,
      );
    }
    if (worstTrade && worstTrade.id !== bestTrade?.id) {
      summaryParts.push(
        `Worst trade: ${worstTrade.instrument?.symbol ?? 'N/A'} (${(worstTrade.pnl ?? 0).toFixed(2)}).`,
      );
    }

    // Strengths
    const strengths: string[] = [];
    if (winRate >= 55) strengths.push(`Solid win rate of ${winRate}%`);
    if (totalPnl > 0) strengths.push(`Profitable week with +${totalPnl.toFixed(2)}`);
    for (const [name, stats] of stratMap) {
      const total = stats.wins + stats.losses;
      const wr = total > 0 ? (stats.wins / total) * 100 : 0;
      if (total >= 3 && wr >= 60) {
        strengths.push(
          `Strategy "${name}" performing well: ${wr.toFixed(0)}% win rate`,
        );
      }
    }
    if (strengths.length === 0) strengths.push('Consistent trade execution');

    // Weaknesses
    const weaknesses: string[] = [];
    if (winRate < 45 && trades.length >= 3)
      weaknesses.push(`Low win rate of ${winRate}%`);
    if (totalPnl < 0)
      weaknesses.push(`Net loss of ${totalPnl.toFixed(2)} this week`);
    for (const [name, stats] of stratMap) {
      const total = stats.wins + stats.losses;
      const wr = total > 0 ? (stats.wins / total) * 100 : 0;
      if (total >= 3 && wr < 35) {
        weaknesses.push(
          `Strategy "${name}" underperforming: ${wr.toFixed(0)}% win rate`,
        );
      }
    }
    if (weaknesses.length === 0) weaknesses.push('No major weaknesses identified');

    // Recommendations
    const recommendations: string[] = [];
    if (winRate < 50)
      recommendations.push('Focus on higher-confidence setups with better risk-reward ratios');
    if (totalPnl < 0)
      recommendations.push('Consider reducing position sizes until performance improves');
    for (const [name, stats] of stratMap) {
      const total = stats.wins + stats.losses;
      const wr = total > 0 ? (stats.wins / total) * 100 : 0;
      if (total >= 3 && wr < 35)
        recommendations.push(`Review or pause "${name}" strategy parameters`);
    }
    if (recommendations.length === 0)
      recommendations.push('Continue current approach and maintain discipline');

    // Overall score (0-100)
    let overallScore = 50;
    overallScore += winRate > 55 ? 15 : winRate < 40 ? -15 : 0;
    overallScore += totalPnl > 0 ? 15 : totalPnl < -1000 ? -20 : -5;
    overallScore += trades.length >= 5 ? 10 : 0;
    overallScore = Math.max(0, Math.min(100, overallScore));

    // Store in database
    const report = await this.prisma.aIWeeklyReport.create({
      data: {
        // Engine-generated report runs with no tenant context → stamp the ADMIN
        // owner so the NOT NULL userId column (TDA-001) is satisfied.
        userId: SYSTEM_USER_ID,
        weekStart,
        weekEnd,
        summary: summaryParts.join(' '),
        strengths: JSON.stringify(strengths),
        weaknesses: JSON.stringify(weaknesses),
        recommendations: JSON.stringify(recommendations),
        overallScore,
      },
    });

    // Call Python engine to retrain with this week's data
    try {
      const tradeOutcomes = trades.map((t) => ({
        symbol: t.instrument?.symbol ?? 'UNKNOWN',
        side: t.side,
        strategy: t.strategy ?? 'unknown',
        pnl: t.pnl ?? 0,
        entry_time: t.entryTime?.toISOString() ?? '',
        exit_time: t.exitTime?.toISOString() ?? '',
        market_regime: 'unknown',
      }));

      if (tradeOutcomes.length > 0) {
        await firstValueFrom(
          this.httpService.post(
            `${this.aiEngineUrl}/api/retrain`,
            { trade_outcomes: tradeOutcomes },
            { timeout: 30000 },
          ),
        );
        this.logger.log(
          `Retrained AI engine with ${tradeOutcomes.length} trades`,
        );
      }
    } catch (error) {
      this.logger.warn('Failed to retrain AI engine', error);
    }

    return {
      id: report.id,
      weekStart: report.weekStart,
      weekEnd: report.weekEnd,
      summary: report.summary,
      strengths,
      weaknesses,
      recommendations,
      overallScore: report.overallScore,
      createdAt: report.createdAt,
    };
  }

  /**
   * Fetch recent weekly reports
   */
  async getReports(limit = 10): Promise<WeeklyReport[]> {
    const reports = await this.prisma.aIWeeklyReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return reports.map((r) => ({
      id: r.id,
      weekStart: r.weekStart,
      weekEnd: r.weekEnd,
      summary: r.summary,
      strengths: JSON.parse(r.strengths) as string[],
      weaknesses: JSON.parse(r.weaknesses) as string[],
      recommendations: JSON.parse(r.recommendations) as string[],
      overallScore: r.overallScore,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Fetch a single report by ID
   */
  async getReportById(id: string): Promise<WeeklyReport | null> {
    const r = await this.prisma.aIWeeklyReport.findUnique({ where: { id } });
    if (!r) return null;

    return {
      id: r.id,
      weekStart: r.weekStart,
      weekEnd: r.weekEnd,
      summary: r.summary,
      strengths: JSON.parse(r.strengths) as string[],
      weaknesses: JSON.parse(r.weaknesses) as string[],
      recommendations: JSON.parse(r.recommendations) as string[],
      overallScore: r.overallScore,
      createdAt: r.createdAt,
    };
  }
}
