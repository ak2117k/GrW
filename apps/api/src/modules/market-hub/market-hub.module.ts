import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { TradeTrackerModule } from '../trade-tracker/trade-tracker.module';
import { MarketHubService } from './market-hub.service';

/**
 * SP1 market data hub. M1 = shadow: running behind MARKET_HUB_ENABLED with
 * metrics, consumed by nobody yet. Imports MarketDataModule for the shared
 * per-user session (UserFeedManager) and TradeTrackerModule for open positions.
 */
@Module({
  imports: [MarketDataModule, TradeTrackerModule],
  providers: [MarketHubService],
  exports: [MarketHubService],
})
export class MarketHubModule {}
