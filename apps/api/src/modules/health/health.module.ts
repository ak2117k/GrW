import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { FEED_STATUS_SOURCE } from './health.types';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketFeedService } from '../market-data/services/market-feed.service';

/**
 * Liveness + keep-warm + freshness endpoint. PrismaService is provided by the
 * @Global PrismaModule, so only the feed needs wiring.
 *
 * `useExisting` binds the ALREADY-RUNNING MarketFeedService singleton behind a
 * narrow token. Two things this must not do, and does not: it must not
 * construct a second feed (that would burn Angel One's ~50-token subscription
 * budget the real feed needs), and it must not require MarketFeedService to
 * grow any new public method — the probe reads `getStatus`, `getSubscribedTokens`
 * and `isMarketOpen` exactly as they already exist. A monitoring concern does
 * not get to reshape the thing it monitors.
 *
 * MarketDataModule does not import HealthModule, so this direction is
 * cycle-free.
 */
@Module({
  imports: [MarketDataModule],
  controllers: [HealthController],
  providers: [HealthService, { provide: FEED_STATUS_SOURCE, useExisting: MarketFeedService }],
})
export class HealthModule {}
