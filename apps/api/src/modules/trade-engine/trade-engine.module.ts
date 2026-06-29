import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SettingsModule } from '../settings/settings.module';
import { InsightsModule } from '../insights/insights.module';
import { OptionsChainModule } from '../options-chain/options-chain.module';

// Controller
import { TradeEngineController } from './controllers/trade-engine.controller';

// Services
import { TradeExecutionService } from './services/trade-execution.service';
import { PositionManagerService } from './services/position-manager.service';
import { PaperTradeService } from './services/paper-trade.service';
import { RiskManagerService } from './services/risk-manager.service';
import { OrderTrackerService } from './services/order-tracker.service';

// Workers
import { SignalReviewWorker } from './workers/signal-review.worker';
import { OpenPaperTradeRefresherWorker } from './workers/open-paper-trade-refresher.worker';

// Repository
import { TradeRepository } from './repositories/trade.repository';

// Gateway
import { TradeGateway } from './gateways/trade.gateway';

@Module({
  imports: [
    PrismaModule,
    MarketDataModule,
    SettingsModule,
    InsightsModule,
    OptionsChainModule,
    BullModule.registerQueue({ name: 'signal-review' }),
  ],
  controllers: [TradeEngineController],
  providers: [
    // Core services
    TradeExecutionService,
    PositionManagerService,
    PaperTradeService,
    RiskManagerService,
    OrderTrackerService,

    // Data access
    TradeRepository,

    // Workers
    SignalReviewWorker,
    OpenPaperTradeRefresherWorker,

    // WebSocket gateway
    TradeGateway,

    // NOTE: BROKER_ADAPTER_TOKEN is intentionally NOT re-declared here.
    // MarketDataModule (imported above) provides it as
    // `useExisting: AngelOneAdapterService` and exports it, so the executor and
    // its siblings resolve the REAL adapter. A previous local
    // `{ provide: BROKER_ADAPTER_TOKEN, useValue: null }` shadowed that import
    // (a module's own provider wins over an imported one), which silently
    // disabled all live order placement. Real-money writes are instead gated by
    // the LIVE_TRADING_ENABLED env flag (see live-trading.ts), not by a null
    // adapter. The injection sites keep `@Optional()` so tests can still run
    // without a broker.
  ],
  exports: [
    TradeExecutionService,
    PositionManagerService,
    RiskManagerService,
    PaperTradeService,
    OrderTrackerService,
    TradeRepository,
    TradeGateway,
  ],
})
export class TradeEngineModule {}
