import { Module } from '@nestjs/common';
import { AdaptiveStopWatchRepository } from './repositories/adaptive-stop-watch.repository';
import { AdaptiveStopTradeRepository } from './repositories/adaptive-stop-trade.repository';
import { AdaptiveStopAccountService } from './services/adaptive-stop-account.service';
import { AdaptiveStopTradeExecutionService } from './services/adaptive-stop-trade-execution.service';
import { AdaptiveStopWatchService } from './services/adaptive-stop-watch.service';
import { AdaptiveStopComparisonService } from './services/adaptive-stop-comparison.service';
import { AdaptiveStopTickPoller } from './services/adaptive-stop-tick-poller.service';
import { AdaptiveStopController } from './controllers/adaptive-stop.controller';
import { AdaptiveStopGateway } from './gateways/adaptive-stop.gateway';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [PrismaModule, MarketDataModule],
  controllers: [AdaptiveStopController],
  providers: [
    AdaptiveStopWatchRepository,
    AdaptiveStopTradeRepository,
    AdaptiveStopAccountService,
    AdaptiveStopTradeExecutionService,
    AdaptiveStopWatchService,
    AdaptiveStopComparisonService,
    AdaptiveStopGateway,
    AdaptiveStopTickPoller,
  ],
  exports: [AdaptiveStopWatchService],
})
export class AdaptiveStopTrackModule {}
