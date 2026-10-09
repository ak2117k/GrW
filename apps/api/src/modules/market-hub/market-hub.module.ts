import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { TradeTrackerModule } from '../trade-tracker/trade-tracker.module';
import { HUB_CANDLE_SOURCE } from './hub-candle-source';
import { HUB_PRICE_SOURCE } from './hub-prices';
import { MarketHubService } from './market-hub.service';

/**
 * SP1 market data hub. M1 = shadow prices; M2 = CandleStore behind
 * HUB_CANDLES_ENABLED, serving /candles behind HUB_SERVES_CHARTS through the
 * HUB_CANDLE_SOURCE token; M3 = position and track prices through the
 * HUB_PRICE_SOURCE token behind HUB_PRICES_POSITIONS / HUB_PRICES_TRACKS.
 * Consumers resolve both tokens lazily: this module imports MarketDataModule
 * and TradeTrackerModule, so a direct injection would cycle.
 */
@Module({
  imports: [MarketDataModule, TradeTrackerModule],
  providers: [
    MarketHubService,
    { provide: HUB_CANDLE_SOURCE, useExisting: MarketHubService },
    { provide: HUB_PRICE_SOURCE, useExisting: MarketHubService },
  ],
  exports: [MarketHubService, HUB_CANDLE_SOURCE, HUB_PRICE_SOURCE],
})
export class MarketHubModule {}
