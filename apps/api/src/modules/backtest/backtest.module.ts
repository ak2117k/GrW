import { Module } from '@nestjs/common';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { BacktestController } from './controllers/backtest.controller';
import { BacktestDataController } from './controllers/backtest-data.controller';
import { BacktestService } from './services/backtest.service';
import { BacktestDataService } from './services/backtest-data.service';
import { DataAcquisitionService } from './services/data-acquisition.service';
import { BacktestRepository } from './repositories/backtest.repository';
import { BacktestDataRepository } from './repositories/backtest-data.repository';
import { BacktestLlmService } from './assistant/backtest-llm.service';
import { BacktestAssistantService } from './assistant/backtest-assistant.service';

/**
 * Backtests: the engine (registry strategies + the Strategy Builder's executor), the long-lived
 * data store (backtest_bars, read first), on-demand history fetches over the owner's Angel session,
 * and the owner-only Claude backtest assistant (AI gateway transport + the sentinel's shared slot,
 * exactly like ai-assist).
 */
@Module({
  imports: [SignalGeneratorModule, MarketDataModule, AiGatewayModule, TradeSentinelModule],
  controllers: [BacktestDataController, BacktestController],
  providers: [
    BacktestService,
    BacktestRepository,
    BacktestDataRepository,
    BacktestDataService,
    DataAcquisitionService,
    BacktestLlmService,
    BacktestAssistantService,
  ],
  exports: [BacktestService],
})
export class BacktestModule {}
