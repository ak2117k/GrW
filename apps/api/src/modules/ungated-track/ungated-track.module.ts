import { Module } from '@nestjs/common';
import { UngatedWatchRepository } from './repositories/ungated-watch.repository';
import { UngatedTradeRepository } from './repositories/ungated-trade.repository';
import { UngatedRejectionRepository } from './repositories/ungated-rejection.repository';
import { UngatedPaperAccountService } from './services/ungated-paper-account.service';
import { UngatedTradeExecutionService } from './services/ungated-trade-execution.service';
import { UngatedWatchService } from './services/ungated-watch.service';
import { UngatedComparisonService } from './services/ungated-comparison.service';
import { UngatedTickPoller } from './services/ungated-tick-poller.service';
import { UngatedTrackController } from './controllers/ungated-track.controller';
import { UngatedWatchGateway } from './gateways/ungated-watch.gateway';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [PrismaModule, MarketDataModule],
  controllers: [UngatedTrackController],
  providers: [
    UngatedWatchRepository,
    UngatedTradeRepository,
    UngatedRejectionRepository,
    UngatedPaperAccountService,
    UngatedTradeExecutionService,
    UngatedWatchService,
    UngatedComparisonService,
    UngatedWatchGateway,
    UngatedTickPoller,
  ],
  exports: [UngatedWatchService, UngatedRejectionRepository],
})
export class UngatedTrackModule {}
