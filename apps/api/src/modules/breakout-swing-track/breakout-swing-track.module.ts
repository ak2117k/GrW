import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { BreakoutSwingRepository } from './repositories/breakout-swing.repository';
import { BreakoutSwingService } from './services/breakout-swing.service';
import { BreakoutSwingPollerService } from './services/breakout-swing-poller.service';
import { BreakoutSwingController } from './controllers/breakout-swing.controller';

// Mirrors AnandDualTrackModule / AdaptiveStopTrackModule: no BullModule — the
// poller is a @nestjs/schedule @Cron (ScheduleModule is registered globally in
// AppModule). MarketDataModule provides AngelOneAdapterService.
@Module({
  imports: [PrismaModule, MarketDataModule],
  controllers: [BreakoutSwingController],
  providers: [BreakoutSwingRepository, BreakoutSwingService, BreakoutSwingPollerService],
  exports: [BreakoutSwingService],
})
export class BreakoutSwingTrackModule {}
