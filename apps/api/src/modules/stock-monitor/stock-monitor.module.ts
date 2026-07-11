import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { StockMonitorService } from './services/stock-monitor.service';
import { StockMonitorPoller } from './services/stock-monitor-poller.service';
import { StockMonitorController } from './controllers/stock-monitor.controller';

/**
 * Target-profit stock monitor (design feature 2). Persists a `stock_monitors`
 * row per user-watched stock with an upside profit target captured at add-time;
 * a poller sweeps live socket quotes and, on a hit, flips the row to
 * TARGET_HIT and fires a persisted `Alert` + a WS `alert` toast.
 *
 * - MarketDataModule supplies {@link MarketFeedService} (subscribe + getQuote +
 *   isMarketOpen) and {@link MarketDataGateway} (the `alert` WS emit path).
 * - Alerts are persisted via `prisma.alert.create` directly (the alert must be
 *   scoped to the monitor's owner and stamped triggered/inactive), so no
 *   dependency on AlertsModule is needed.
 */
@Module({
  imports: [PrismaModule, MarketDataModule],
  controllers: [StockMonitorController],
  providers: [StockMonitorService, StockMonitorPoller],
  exports: [StockMonitorService],
})
export class StockMonitorModule {}
