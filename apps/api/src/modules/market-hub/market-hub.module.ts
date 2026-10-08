import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { TradeTrackerModule } from '../trade-tracker/trade-tracker.module';
import { HUB_CANDLE_SOURCE } from './hub-candle-source';
import { MarketHubService } from './market-hub.service';

/**
 * SP1 market data hub. M1 = shadow prices; M2 = CandleStore behind
 * HUB_CANDLES_ENABLED, serving /candles behind HUB_SERVES_CHARTS through the
 * HUB_CANDLE_SOURCE token (the market-data controller resolves it lazily:
 * this module imports MarketDataModule, so a direct injection would cycle).
 */
@Module({
  imports: [MarketDataModule, TradeTrackerModule],
  providers: [MarketHubService, { provide: HUB_CANDLE_SOURCE, useExisting: MarketHubService }],
  exports: [MarketHubService, HUB_CANDLE_SOURCE],
})
export class MarketHubModule {}
