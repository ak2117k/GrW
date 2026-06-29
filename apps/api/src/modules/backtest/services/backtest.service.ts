import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { StrategyRegistryService } from '../../signal-generator/services/strategy-registry.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { BacktestRepository } from '../repositories/backtest.repository';
import { RunBacktestDto } from '../dto/backtest.dto';
import type {
  BacktestResult,
  CandleData,
} from '../../../common/interfaces/trading-strategy.interface';

/**
 * Token lookup map for common instruments so backtests can run even when the
 * local instrument DB is empty.  Maps uppercase symbol → Angel One token/exchange.
 */
const TOKEN_MAP: Record<string, { token: string; exchange: string }> = {
  'NIFTY': { token: '99926000', exchange: 'NSE' },
  'BANKNIFTY': { token: '99926009', exchange: 'NSE' },
  'FINNIFTY': { token: '99926037', exchange: 'NSE' },
  'SENSEX': { token: '99919000', exchange: 'BSE' },
  'RELIANCE': { token: '2885', exchange: 'NSE' },
  'TCS': { token: '11536', exchange: 'NSE' },
  'HDFCBANK': { token: '1333', exchange: 'NSE' },
  'INFY': { token: '1594', exchange: 'NSE' },
  'ICICIBANK': { token: '4963', exchange: 'NSE' },
};

export interface ComparisonResult {
  configs: RunBacktestDto[];
  results: Array<BacktestResult & { strategy: string }>;
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly marketDataRepo: MarketDataRepository,
    private readonly angelOneAdapter: AngelOneAdapterService,
    private readonly backtestRepo: BacktestRepository,
  ) {}

  /**
   * Run a single backtest for a given configuration.
   */
  async runBacktest(config: RunBacktestDto): Promise<BacktestResult> {
    // 1. Get strategy from registry
    const strategy = this.strategyRegistry.getStrategy(config.strategy);
    if (!strategy) {
      throw new NotFoundException(
        `Strategy "${config.strategy}" not found in registry`,
      );
    }

    // 2. Resolve instrument token + exchange for the Angel One fetch.
    let token: string = config.symbol;
    let exchange: string = config.exchange;

    const instruments = await this.marketDataRepo.searchInstruments(
      config.symbol,
      config.exchange,
    );

    if (instruments.length > 0) {
      const instrument = instruments[0];
      token = instrument.token ?? token;
      exchange = instrument.exchange ?? exchange;
    } else {
      // Instrument not in local DB — resolve from TOKEN_MAP
      const mapped = TOKEN_MAP[config.symbol.toUpperCase()];
      if (mapped) {
        token = mapped.token;
        exchange = mapped.exchange;
        this.logger.warn(
          `Instrument "${config.symbol}" not in DB, using TOKEN_MAP: token=${token} exchange=${exchange}`,
        );
      } else {
        this.logger.warn(
          `Instrument "${config.symbol}" not in DB or TOKEN_MAP, using symbol as token`,
        );
      }
    }

    // 3. Fetch historical candles straight from Angel One.
    // The local `candles` table is NOT a backtest-grade historical store — it
    // holds only stray live-aggregation candles. A "local DB first" path let a
    // single stray candle suppress the broker fetch and silently starve the
    // backtest, so backtests always pull the full range from the broker.
    let candles: CandleData[] = [];
    try {
      const angelCandles = await this.angelOneAdapter.getHistoricalData(
        token,
        exchange,
        config.timeframe,
        config.startDate,
        config.endDate,
      );

      candles = angelCandles.map((c) => ({
        timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
      }));

      this.logger.log(
        `Fetched ${candles.length} candles from Angel One for ${config.symbol} (token=${token}, exchange=${exchange})`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Angel One historical data fetch failed: ${msg}`);
    }

    if (candles.length === 0) {
      throw new BadRequestException(
        `No candle data available for ${config.symbol} (${config.timeframe}) between ${config.startDate.toISOString()} and ${config.endDate.toISOString()} (Angel One token=${token}).`,
      );
    }

    this.logger.log(
      `Running backtest: ${config.strategy} on ${config.symbol} (${candles.length} candles)`,
    );

    // 4. Apply custom parameters if provided, then run backtest, then restore
    const originalParams = strategy.getParameters();
    if (config.parameters && Object.keys(config.parameters).length > 0) {
      strategy.setParameters(config.parameters);
      this.logger.log(
        `Applied custom parameters: ${JSON.stringify(config.parameters)}`,
      );
    }

    const result = await strategy.backtest({
      candles,
      initialCapital: config.initialCapital,
      positionSize: config.positionSize,
      symbol: config.symbol,
      token,
      exchange,
      timeframe: config.timeframe,
      startDate: config.startDate,
      endDate: config.endDate,
    });

    // Restore original parameters so other backtests aren't affected
    strategy.setParameters(originalParams);

    // 5. Save to DB
    await this.backtestRepo.saveBacktestRun({
      strategy: config.strategy,
      parameters: {
        symbol: config.symbol,
        exchange: config.exchange,
        timeframe: config.timeframe,
        initialCapital: config.initialCapital,
        positionSize: config.positionSize,
      },
      startDate: config.startDate,
      endDate: config.endDate,
      totalTrades: result.totalTrades,
      winRate: result.winRate,
      totalReturn: result.totalReturn,
      maxDrawdown: result.maxDrawdown,
      sharpeRatio: result.sharpeRatio,
      results: result,
    });

    this.logger.log(
      `Backtest complete: ${result.totalTrades} trades, ${result.winRate.toFixed(1)}% win rate, ${result.totalReturnPercent.toFixed(2)}% return`,
    );

    return result;
  }

  /**
   * Compare multiple strategies side by side.
   */
  async compareStrategies(
    configs: RunBacktestDto[],
  ): Promise<ComparisonResult> {
    if (configs.length < 2 || configs.length > 5) {
      throw new BadRequestException(
        'Comparison requires between 2 and 5 strategy configurations',
      );
    }

    const results = await Promise.all(
      configs.map(async (config) => {
        const result = await this.runBacktest(config);
        return { ...result, strategy: config.strategy };
      }),
    );

    return { configs, results };
  }

  /**
   * Get history of past backtest runs.
   */
  async getBacktestHistory(limit = 20, offset = 0) {
    return this.backtestRepo.getBacktestRuns(limit, offset);
  }

  /**
   * Get a single backtest run by ID.
   */
  async getBacktestById(id: string) {
    const run = await this.backtestRepo.getBacktestById(id);
    if (!run) {
      throw new NotFoundException(`Backtest run "${id}" not found`);
    }
    return run;
  }

  /**
   * Delete a backtest run.
   */
  async deleteBacktest(id: string) {
    const existing = await this.backtestRepo.getBacktestById(id);
    if (!existing) {
      throw new NotFoundException(`Backtest run "${id}" not found`);
    }
    await this.backtestRepo.deleteBacktest(id);
    return { success: true };
  }
}
