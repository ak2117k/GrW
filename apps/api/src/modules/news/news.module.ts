import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { NewsController } from './controllers/news.controller';
import { NewsAggregatorService } from './services/news-aggregator.service';
import { NewsSentimentService } from './services/news-sentiment.service';
import { NewsFetchProcessor } from './workers/news-fetch.processor';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Scheduler that enqueues news-fetch jobs every 5 minutes during
 * Indian market hours (Mon-Fri 09:00-16:00 IST).
 */
@Injectable()
class NewsFetchScheduler {
  private readonly logger = new Logger(NewsFetchScheduler.name);

  constructor(
    @InjectQueue('news-fetch') private readonly newsFetchQueue: Queue,
  ) {}

  // Every 5 minutes, Mon-Fri, 9:00-15:59 IST (03:30-10:29 UTC)
  @Cron('0 */5 3-10 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async scheduleNewsFetch() {
    this.logger.log('Scheduling periodic news fetch job');
    await this.newsFetchQueue.add(
      {},
      {
        removeOnComplete: true,
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
      },
    );
  }
}

@Module({
  imports: [
    BullModule.registerQueue({ name: 'news-fetch' }),
    HttpModule.register({ timeout: 15000 }),
    PrismaModule,
  ],
  controllers: [NewsController],
  providers: [
    NewsAggregatorService,
    NewsSentimentService,
    NewsFetchProcessor,
    NewsFetchScheduler,
  ],
  exports: [NewsAggregatorService, NewsSentimentService],
})
export class NewsModule {}
