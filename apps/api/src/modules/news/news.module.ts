import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { NewsEventsCoreModule } from '../news-events/news-events-core.module';
import { NewsController } from './controllers/news.controller';
import { NewsAggregatorService } from './services/news-aggregator.service';
import { NewsSentimentService } from './services/news-sentiment.service';
import { NewsSymbolIndexService } from './services/news-symbol-index.service';
import { NewsFetchProcessor } from './workers/news-fetch.processor';
import { NewsFetchScheduler } from './news-fetch.schedule';
import { RetagService } from '../news-events/ingest/retag.service';
import { AliasLoaderService } from '../news-events/tagging/alias-loader.service';
import { NewsTaggerService } from '../news-events/tagging/tagger.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'news-fetch' }),
    HttpModule.register({ timeout: 15000 }),
    PrismaModule,
    NewsEventsCoreModule,
  ],
  controllers: [NewsController],
  providers: [
    NewsAggregatorService,
    NewsSentimentService,
    NewsSymbolIndexService,
    NewsFetchProcessor,
    NewsFetchScheduler,
    NewsTaggerService,
    AliasLoaderService,
    RetagService,
  ],
  exports: [NewsAggregatorService, NewsSentimentService, NewsTaggerService],
})
export class NewsModule {}
