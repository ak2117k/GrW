import { Global, Module, OnApplicationBootstrap } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';
import { OptionsChainModule } from '../options-chain/options-chain.module';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { ChartinkModule } from '../chartink/chartink.module';
import { WatchRepository } from './repositories/watch.repository';
import { WatchService } from './services/watch.service';
import { WatchMonitorService } from './services/watch-monitor.service';
import { StrikeSelectorService } from './services/strike-selector.service';
import { TargetCalculatorService } from './services/target-calculator.service';
import { WatchRescoreWorker, WATCH_RESCORE_QUEUE } from './workers/watch-rescore.worker';
import { WatchController } from './controllers/watch.controller';
import { WatchGateway } from './gateways/watch.gateway';
import { MarketFeedService } from '../market-data/services/market-feed.service';
import { RiskGuardService } from './services/risk-guard.service';
import { WatchBackstopPollerService } from './services/watch-backstop-poller.service';

@Global()
@Module({
  imports: [
    PrismaModule,
    MarketDataModule,
    SignalGeneratorModule,
    OptionsChainModule,
    TradeEngineModule,
    ChartinkModule,
    BullModule.registerQueue({ name: WATCH_RESCORE_QUEUE }),
  ],
  controllers: [WatchController],
  providers: [
    WatchRepository,
    WatchService,
    WatchMonitorService,
    RiskGuardService,
    WatchBackstopPollerService,
    StrikeSelectorService,
    TargetCalculatorService,
    WatchRescoreWorker,
    WatchGateway,
  ],
  exports: [WatchService, WatchRepository],
})
export class WatchMonitorModule implements OnApplicationBootstrap {
  constructor(
    private readonly watch: WatchService,
    private readonly feed: MarketFeedService,
  ) {}

  async onApplicationBootstrap() {
    this.feed.registerWatchTickHandler(async (token, ltp, ts) => {
      await this.watch.onTick(token, ltp, ts);
    });
  }
}
