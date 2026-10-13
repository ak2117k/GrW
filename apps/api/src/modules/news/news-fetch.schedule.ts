import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

/**
 * When news is ingested: every 5 minutes, weekdays, 08:00–23:30 IST — the NSE
 * session with its pre-open, AND the MCX evening session (which runs to 23:30).
 *
 * Six-field (seconds first) and evaluated in IST (`timeZone`), so the hour
 * fields ARE IST hours. The expression this replaces, '0 *\/5 3-10 * * 1-5', was
 * written as UTC hours (03:30–10:29 UTC = 09:00–15:59 IST) but then given
 * `timeZone: 'Asia/Kolkata'` — so it actually ran 03:00–10:59 IST, and nothing
 * was ingested after 11:00 IST: every afternoon and every MCX evening the news
 * store went quiet, and the sentinel read that quiet as "no headlines".
 *
 * Two expressions because one cron cannot stop at :30 of its last hour.
 */
export const NEWS_FETCH_CRONS = {
  day: '0 */5 8-22 * * 1-5',
  lateMcx: '0 0-30/5 23 * * 1-5',
} as const;

/** Enqueues one news-fetch job per fire; the processor does the HTTP. */
@Injectable()
export class NewsFetchScheduler {
  private readonly logger = new Logger(NewsFetchScheduler.name);

  constructor(@InjectQueue('news-fetch') private readonly newsFetchQueue: Queue) {}

  @Cron(NEWS_FETCH_CRONS.day, { timeZone: 'Asia/Kolkata' })
  async scheduleNewsFetch(): Promise<void> {
    await this.enqueue();
  }

  @Cron(NEWS_FETCH_CRONS.lateMcx, { timeZone: 'Asia/Kolkata' })
  async scheduleLateNewsFetch(): Promise<void> {
    await this.enqueue();
  }

  private async enqueue(): Promise<void> {
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
