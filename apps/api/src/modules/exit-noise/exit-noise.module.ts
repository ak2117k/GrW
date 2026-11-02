import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { ExitNoiseFollowCron } from './exit-noise-follow.cron';
import { ExitNoiseRepository } from './exit-noise.repository';
import { ExitNoiseReadService } from './exit-noise.service';

/**
 * "Noise or real?" at every AI exit (owner 2026-10-30): RECORD ONLY. The exit paths — the paper
 * sentinel (paper / signal paper trades), the real auto-exit poller (EXIT_NOW) and the price-trigger
 * watch — inject ExitNoiseReadService @Optional() and fire it after the exit decision without
 * awaiting it. @Global so those modules need no import (and boot unchanged without it).
 * MarketDataModule: UserFeedManager, the follow-up cron's broker 1m-history fallback (@Optional there).
 */
@Global()
@Module({
  imports: [PrismaModule, MarketDataModule],
  providers: [ExitNoiseRepository, ExitNoiseReadService, ExitNoiseFollowCron],
  exports: [ExitNoiseReadService],
})
export class ExitNoiseModule {}
