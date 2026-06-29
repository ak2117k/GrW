import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { SettingsModule } from '../settings/settings.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { AutoTradeController } from './controllers/auto-trade.controller';
import { AutoTradeService } from './services/auto-trade.service';
import { AutoTradeGateway } from './gateways/auto-trade.gateway';

@Module({
  imports: [
    PrismaModule,
    SignalGeneratorModule,
    TradeEngineModule,
    SettingsModule,
    MarketDataModule,
  ],
  controllers: [AutoTradeController],
  providers: [AutoTradeService, AutoTradeGateway],
  exports: [AutoTradeService],
})
export class AutoTradeModule {}
