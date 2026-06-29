import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { BrokerController } from './controllers/broker.controller';
import { BrokerService } from './services/broker.service';

@Module({
  imports: [PrismaModule, MarketDataModule],
  controllers: [BrokerController],
  providers: [BrokerService],
  exports: [BrokerService],
})
export class BrokerModule {}
