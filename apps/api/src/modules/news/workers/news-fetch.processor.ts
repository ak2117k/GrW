import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { NewsAggregatorService } from '../services/news-aggregator.service';

@Processor('news-fetch')
export class NewsFetchProcessor {
  private readonly logger = new Logger(NewsFetchProcessor.name);

  constructor(
    private readonly newsAggregatorService: NewsAggregatorService,
  ) {}

  @Process({ concurrency: 1 })
  async handleNewsFetch(job: Job): Promise<void> {
    this.logger.debug(`Processing news-fetch job ${job.id}...`);

    try {
      const savedCount = await this.newsAggregatorService.fetchAllNews();
      this.logger.log(
        `News fetch job ${job.id} completed — ${savedCount} new articles saved`,
      );
    } catch (error) {
      this.logger.error(
        `News fetch job ${job.id} failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
      throw error;
    }
  }
}
