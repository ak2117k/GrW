import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { TelegramTrackerService } from '../services/telegram-tracker.service';
import { TelegramTrackJobData } from '../services/telegram-ingest.service';

@Processor('telegram-track')
export class TelegramTrackProcessor {
  private readonly logger = new Logger(TelegramTrackProcessor.name);
  constructor(private readonly tracker: TelegramTrackerService) {}

  @Process('track')
  async handle(job: Job<TelegramTrackJobData>): Promise<void> {
    await this.tracker.evaluateOne(job.data.signalId);
  }
}
