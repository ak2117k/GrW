import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { BacktestResult } from '../../../common/interfaces/trading-strategy.interface';

export interface SaveBacktestRunInput {
  strategy: string;
  parameters: Record<string, any>;
  startDate: Date;
  endDate: Date;
  totalTrades: number;
  winRate: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpeRatio: number;
  results: BacktestResult;
}

@Injectable()
export class BacktestRepository {
  private readonly logger = new Logger(BacktestRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Save a backtest run with JSON-serialized results.
   */
  async saveBacktestRun(data: SaveBacktestRunInput) {
    try {
      return await this.prisma.backtestRun.create({
        data: {
          strategy: data.strategy,
          parameters: JSON.stringify(data.parameters),
          startDate: data.startDate,
          endDate: data.endDate,
          totalTrades: data.totalTrades,
          winRate: data.winRate,
          totalReturn: data.totalReturn,
          maxDrawdown: data.maxDrawdown,
          sharpeRatio: data.sharpeRatio,
          results: JSON.stringify(data.results),
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to save backtest run: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  /**
   * Get paginated backtest run history.
   */
  async getBacktestRuns(limit = 20, offset = 0) {
    const runs = await this.prisma.backtestRun.findMany({
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
    });

    return runs.map((run) => ({
      ...run,
      parameters: JSON.parse(run.parameters),
      results: JSON.parse(run.results),
    }));
  }

  /**
   * Get a single backtest run by ID with parsed JSON results.
   */
  async getBacktestById(id: string) {
    const run = await this.prisma.backtestRun.findUnique({
      where: { id },
    });

    if (!run) return null;

    return {
      ...run,
      parameters: JSON.parse(run.parameters),
      results: JSON.parse(run.results),
    };
  }

  /**
   * Delete a backtest run.
   */
  async deleteBacktest(id: string) {
    return this.prisma.backtestRun.delete({
      where: { id },
    });
  }
}
