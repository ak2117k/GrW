import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { OptionsChainModule } from '../options-chain/options-chain.module';
import { TelegramRepository } from './repositories/telegram.repository';
import { TelegramIngestService } from './services/telegram-ingest.service';
import { TelegramTrackerService } from './services/telegram-tracker.service';
import { TelegramStatsService } from './services/telegram-stats.service';
import { TelegramTrackProcessor } from './workers/telegram-track.processor';
import { TelegramGateway } from './gateways/telegram.gateway';
import { TelegramIngestController } from './controllers/telegram-ingest.controller';
import { TelegramController } from './controllers/telegram.controller';

@Module({
  imports: [
    PrismaModule,
    MarketDataModule,
    OptionsChainModule,
    BullModule.registerQueue({ name: 'telegram-track' }),
  ],
  controllers: [TelegramIngestController, TelegramController],
  providers: [
    TelegramRepository,
    TelegramIngestService,
    TelegramTrackerService,
    TelegramStatsService,
    TelegramTrackProcessor,
    TelegramGateway,
  ],
  exports: [TelegramRepository],
})
export class TelegramModule {}
