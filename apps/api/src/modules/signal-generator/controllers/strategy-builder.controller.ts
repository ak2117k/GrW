import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { StrategyParserService, ParseResult } from '../services/strategy-parser.service';
import { StrategyExecutorService } from '../services/strategy-executor.service';
import { StrategyStorageService } from '../services/strategy-storage.service';
import {
  UserStrategyDto,
  ValidateStrategyDto,
  UserStrategyBacktestDto,
} from '../dto/user-strategy.dto';
import {
  CandleData,
  BacktestResult,
} from '../../../common/interfaces/trading-strategy.interface';
import { AdminOnly } from '../../../common/decorators';

@AdminOnly()
@Controller('api/strategies')
export class StrategyBuilderController {
  private readonly logger = new Logger(StrategyBuilderController.name);

  constructor(
    private readonly parser: StrategyParserService,
    private readonly executor: StrategyExecutorService,
    private readonly storage: StrategyStorageService,
  ) {}

  // ── Validate strategy code ────────────────────────────────────────

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  async validateStrategy(@Body() dto: ValidateStrategyDto): Promise<ParseResult> {
    this.logger.log(`Validating ${dto.type} strategy`);
    return this.parser.parse(dto.code, dto.type);
  }

  // ── Save a user strategy ──────────────────────────────────────────

  @Post('save')
  @HttpCode(HttpStatus.CREATED)
  async saveStrategy(@Body() dto: UserStrategyDto): Promise<{ id: string }> {
    // Pre-validate if it's a script strategy
    if (dto.type === 'script' && dto.code) {
      const result = this.parser.parse(dto.code, 'script');
      if (!result.valid) {
        throw new BadRequestException({
          message: 'Strategy code has errors',
          errors: result.errors,
        });
      }
    }

    const saved = this.storage.save(dto);
    this.logger.log(`Strategy saved: ${saved.name} (${saved.id})`);
    return { id: saved.id! };
  }

  // ── List all user strategies ───────────────────────────────────────

  @Get()
  async listStrategies(): Promise<UserStrategyDto[]> {
    return this.storage.findAll();
  }

  // ── Get a specific strategy ────────────────────────────────────────

  @Get(':id')
  async getStrategy(@Param('id') id: string): Promise<UserStrategyDto> {
    const strategy = this.storage.findById(id);
    if (!strategy) {
      throw new NotFoundException(`Strategy ${id} not found`);
    }
    return strategy;
  }

  // ── Delete a strategy ──────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteStrategy(@Param('id') id: string): Promise<void> {
    const deleted = this.storage.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Strategy ${id} not found`);
    }
  }

  // ── Backtest a user strategy ───────────────────────────────────────

  @Post(':id/backtest')
  @HttpCode(HttpStatus.OK)
  async backtestStrategy(
    @Param('id') id: string,
    @Body() config: UserStrategyBacktestDto,
  ): Promise<BacktestResult> {
    const strategy = this.storage.findById(id);
    if (!strategy) {
      throw new NotFoundException(`Strategy ${id} not found`);
    }

    // Parse the strategy code
    const code = strategy.type === 'visual'
      ? JSON.stringify({
          name: strategy.name,
          indicators: strategy.indicators,
          entryRules: strategy.entryRules,
          exitRules: strategy.exitRules,
          timeframes: strategy.timeframes,
        })
      : strategy.code ?? '';

    const parseResult = this.parser.parse(code, strategy.type);
    if (!parseResult.valid || !parseResult.parsed) {
      throw new BadRequestException({
        message: 'Strategy code has errors — cannot backtest',
        errors: parseResult.errors,
      });
    }

    // Generate sample candle data for backtesting
    // In production this would come from the market-data module or historical DB
    const candles = this.generateSampleCandles(config);

    const result = this.executor.executeBacktest(
      parseResult.parsed,
      candles,
      config.initialCapital ?? 1_000_000,
      config.positionSize ?? 1,
    );

    this.logger.log(
      `Backtest complete for "${strategy.name}": ${result.totalTrades} trades, ` +
      `${result.winRate.toFixed(1)}% win rate, ${result.totalReturnPercent.toFixed(2)}% return`,
    );

    return result;
  }

  // ────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────

  /**
   * Generate synthetic candle data for backtesting when historical data is
   * not yet available from the market-data module. Uses a random walk
   * seeded from a base price with realistic volatility.
   */
  private generateSampleCandles(config: UserStrategyBacktestDto): CandleData[] {
    const candles: CandleData[] = [];
    const start = new Date(config.startDate);
    const end = new Date(config.endDate);

    // Determine candle interval in milliseconds
    const intervalMap: Record<string, number> = {
      '1m': 60_000,
      '3m': 180_000,
      '5m': 300_000,
      '15m': 900_000,
      '30m': 1_800_000,
      '1h': 3_600_000,
      '4h': 14_400_000,
      '1d': 86_400_000,
    };
    const interval = intervalMap[config.timeframe] ?? 900_000;

    let basePrice = 20000; // Nifty-like base
    let time = start.getTime();

    while (time <= end.getTime()) {
      const volatility = basePrice * 0.005; // 0.5% per candle
      const change = (Math.random() - 0.5) * 2 * volatility;
      const open = basePrice;
      const close = open + change;
      const high = Math.max(open, close) + Math.random() * volatility * 0.5;
      const low = Math.min(open, close) - Math.random() * volatility * 0.5;
      const volume = Math.floor(50_000 + Math.random() * 200_000);

      candles.push({
        timestamp: new Date(time),
        open: Math.round(open * 100) / 100,
        high: Math.round(high * 100) / 100,
        low: Math.round(low * 100) / 100,
        close: Math.round(close * 100) / 100,
        volume,
      });

      basePrice = close;
      time += interval;
    }

    return candles;
  }
}
