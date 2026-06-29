import { Module } from '@nestjs/common';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { BacktestController } from './controllers/backtest.controller';
import { BacktestService } from './services/backtest.service';
import { BacktestRepository } from './repositories/backtest.repository';

@Module({
  imports: [SignalGeneratorModule, MarketDataModule],
  controllers: [BacktestController],
  providers: [BacktestService, BacktestRepository],
  exports: [BacktestService],
})
export class BacktestModule {}
