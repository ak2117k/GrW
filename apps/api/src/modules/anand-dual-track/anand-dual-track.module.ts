import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { AnandDualTrackRepository } from './repositories/anand-dual-track.repository';
import { AnandDualTrackService } from './services/anand-dual-track.service';
import { AnandPriceMonitorService } from './services/anand-price-monitor.service';
import { ReinvestmentService } from './services/reinvestment.service';
import { SwingOhlcService } from './services/swing-ohlc.service';
import { AnandDualTrackController } from './controllers/anand-dual-track.controller';

// ChartinkModule is @Global(), so ChartinkRepository is available without importing it here.
// ChartinkModule imports AnandDualTrackModule — importing ChartinkModule here would be circular.
@Module({
  imports: [PrismaModule, MarketDataModule, SubscriptionModule],
  controllers: [AnandDualTrackController],
  providers: [AnandDualTrackRepository, AnandDualTrackService, AnandPriceMonitorService, ReinvestmentService, SwingOhlcService],
  exports: [AnandDualTrackService],
})
export class AnandDualTrackModule {}
