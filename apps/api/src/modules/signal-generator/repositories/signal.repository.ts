import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SignalFilterDto } from '../dto/signal.dto';

export interface CreateSignalInput {
  instrumentId: string;
  side: string;
  entryPrice: number;
  targetPrice: number;
  stoplossPrice: number;
  expectedProfit: number;
  expectedLoss: number;
  riskRewardRatio: number;
  confidence: string;
  confidenceScore: number;
  strategy: string;
  timeframe: string;
  reason: string;
  expiresAt?: Date;
}

export interface StrategyPerformance {
  totalSignals: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  averagePnl: number;
  totalPnl: number;
}

@Injectable()
export class SignalRepository {
  private readonly logger = new Logger(SignalRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async createSignal(data: CreateSignalInput) {
    try {
      return await this.prisma.signal.create({
        data: {
          instrumentId: data.instrumentId,
          side: data.side,
          entryPrice: data.entryPrice,
          targetPrice: data.targetPrice,
          stoplossPrice: data.stoplossPrice,
          expectedProfit: data.expectedProfit,
          expectedLoss: data.expectedLoss,
          riskRewardRatio: data.riskRewardRatio,
          confidence: data.confidence,
          confidenceScore: data.confidenceScore,
          strategy: data.strategy,
          timeframe: data.timeframe,
          reason: data.reason,
          isActive: true,
          expiresAt: data.expiresAt ?? null,
        },
        include: { instrument: true },
      });
    } catch (error) {
      this.logger.error(
        `Failed to create signal: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  /**
   * Active signals plus, optionally, recently-expired ones. The Signals
   * page uses `recentHours > 0` so users can see what fired earlier in
   * the day even after a signal's session-end TTL kicked in. Each row
   * still carries its true `isActive` flag — the frontend renders
   * expired ones with a faded badge.
   */
  async getActiveSignals(recentHours = 0) {
    if (recentHours <= 0) {
      return this.prisma.signal.findMany({
        where: { isActive: true },
        include: { instrument: true },
        orderBy: { confidenceScore: 'desc' },
      });
    }
    const since = new Date(Date.now() - recentHours * 60 * 60 * 1000);
    return this.prisma.signal.findMany({
      where: {
        OR: [
          { isActive: true },
          { isActive: false, createdAt: { gte: since } },
        ],
      },
      include: { instrument: true },
      orderBy: [{ isActive: 'desc' }, { confidenceScore: 'desc' }],
    });
  }

  async getSignalHistory(filters: SignalFilterDto) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (filters.strategy) {
      where.strategy = filters.strategy;
    }
    if (filters.confidence) {
      where.confidence = filters.confidence;
    }
    if (filters.minScore !== undefined) {
      where.confidenceScore = { gte: filters.minScore };
    }
    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive;
    }
    if (filters.segment) {
      where.instrument = { segment: filters.segment };
    }
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) {
        where.createdAt.gte = new Date(filters.from);
      }
      if (filters.to) {
        where.createdAt.lte = new Date(filters.to);
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.signal.findMany({
        where,
        include: { instrument: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.signal.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async deactivateSignal(id: string) {
    try {
      return await this.prisma.signal.update({
        where: { id },
        data: { isActive: false },
      });
    } catch (error) {
      this.logger.error(
        `Failed to deactivate signal ${id}: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  /**
   * Mark active signals as inactive once their expiresAt has passed.
   * Each signal carries its own session-aware TTL (set at creation time
   * by SignalGeneratorService.computeExpiry), so we just trust that field
   * here — no global maxAge override.
   */
  async deactivateExpiredSignals(): Promise<number> {
    try {
      const result = await this.prisma.signal.updateMany({
        where: {
          isActive: true,
          expiresAt: { lt: new Date() },
        },
        data: { isActive: false },
      });

      if (result.count > 0) {
        this.logger.log(`Deactivated ${result.count} expired signals`);
      }

      return result.count;
    } catch (error) {
      this.logger.error(
        `Failed to deactivate expired signals: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  /**
   * One-time / ongoing cleanup for legacy rows that pre-date the
   * expiresAt-on-create fix. Any signal older than 24h with a null
   * expiry is unambiguously stale (no live trader is acting on a day-old
   * signal), so we flip isActive off. The cron sweep runs this every
   * 5 min — once the backlog is drained, subsequent calls are no-ops
   * because new signals all have explicit expiry.
   */
  async deactivateLegacyNullExpiry(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const result = await this.prisma.signal.updateMany({
        where: {
          isActive: true,
          expiresAt: null,
          createdAt: { lt: cutoff },
        },
        data: { isActive: false },
      });
      return result.count;
    } catch (error) {
      this.logger.error(
        `Failed to deactivate legacy null-expiry signals: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  async getSignalById(id: string) {
    return this.prisma.signal.findUnique({
      where: { id },
      include: { instrument: true, trades: true },
    });
  }

  async getStrategyPerformance(
    strategyName: string,
    fromDate: Date,
  ): Promise<StrategyPerformance> {
    const signals = await this.prisma.signal.findMany({
      where: {
        strategy: strategyName,
        createdAt: { gte: fromDate },
      },
      select: { id: true },
    });

    const signalIds = signals.map((s) => s.id);

    const trades = await this.prisma.trade.findMany({
      where: {
        signalId: { in: signalIds },
        status: { in: ['CLOSED', 'FILLED'] },
      },
      select: { pnl: true },
    });

    const winningTrades = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const losingTrades = trades.filter((t) => (t.pnl ?? 0) <= 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const averagePnl = trades.length > 0 ? totalPnl / trades.length : 0;

    return {
      totalSignals: signals.length,
      totalTrades: trades.length,
      winningTrades,
      losingTrades,
      winRate: trades.length > 0 ? (winningTrades / trades.length) * 100 : 0,
      averagePnl: Math.round(averagePnl * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
    };
  }
}
