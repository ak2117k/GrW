import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { FundamentalsModule } from '../../fundamentals/fundamentals.module';
import { NewsEventsCoreModule } from '../news-events-core.module';
import { EventsBuilderService } from './events-builder.service';
import { EventsService } from './events.service';
import { MarketEventsRepository } from './market-events.repository';

@Module({
  imports: [NewsEventsCoreModule, PrismaModule, FundamentalsModule],
  providers: [MarketEventsRepository, EventsBuilderService, EventsService],
  exports: [EventsService],
})
export class MarketEventsModule {}
