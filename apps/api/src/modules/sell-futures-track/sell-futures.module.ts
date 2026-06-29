import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SellFuturesWatchRepository } from './repositories/sell-futures-watch.repository';
import { SellFuturesTradeRepository } from './repositories/sell-futures-trade.repository';
import { SellFuturesRejectionRepository } from './repositories/sell-futures-rejection.repository';
import { SellFuturesPaperAccountService } from './services/sell-futures-paper-account.service';
import { FutureSelectorService } from './services/future-selector.service';
import { SellFuturesService } from './services/sell-futures.service';
import { SellFuturesTickPoller } from './services/sell-futures-tick-poller.service';
import { SellFuturesController } from './controllers/sell-futures.controller';

/**
 * SELL-Futures shadow track — shorts the resolved stock FUTURE (NFO) on bearish
 * Chartink signals. Paper-only this iteration. ExitPriceService is provided by
 * the @Global SignalGeneratorModule (same as the ungated track).
 */
@Module({
  imports: [PrismaModule, MarketDataModule],
  controllers: [SellFuturesController],
  providers: [
    SellFuturesWatchRepository,
    SellFuturesTradeRepository,
    SellFuturesRejectionRepository,
    SellFuturesPaperAccountService,
    FutureSelectorService,
    SellFuturesService,
    SellFuturesTickPoller,
  ],
  exports: [SellFuturesService, SellFuturesRejectionRepository],
})
export class SellFuturesModule {}
