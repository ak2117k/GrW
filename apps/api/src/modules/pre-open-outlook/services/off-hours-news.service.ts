import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Queue } from 'bull';
import { offHoursNewsDue, offHoursNewsEnabled, PRE_OPEN_CRONS } from '../domain/schedule';

/**
 * OFF-HOURS NEWS FETCH (2026-11-02). The RSS news fetch (news/news-fetch.schedule.ts) runs weekdays
 * 08:00–23:30 IST only, so prod ingested NOTHING but NSE announcements from Fri 23:30 to Mon 08:00:
 * every weekend US–Iran / crude story reached news_clusters at 08:00 Monday and was first analysed
 * at 09:00 (news-impact itself runs off-session every 2 h — it simply had nothing to read).
 *
 * This enqueues the SAME 'news-fetch' job (same processor, same feeds, free HTTP) every 30 min
 * outside that window: weekday nights 00:00–07:30 and all weekend. The news module is unchanged.
 * NEWS_OFFHOURS_FETCH=off / BOOT_JOBS=false stop it.
 */
@Injectable()
export class OffHoursNewsService {
  private readonly logger = new Logger(OffHoursNewsService.name);

  constructor(@InjectQueue('news-fetch') private readonly queue: Queue) {}

  @Cron(PRE_OPEN_CRONS.newsOffHoursWeekday, { name: 'news-offhours-weekday', timeZone: 'Asia/Kolkata' })
  async weekday(): Promise<void> {
    await this.enqueue(new Date());
  }

  @Cron(PRE_OPEN_CRONS.newsOffHoursWeekend, { name: 'news-offhours-weekend', timeZone: 'Asia/Kolkata' })
  async weekend(): Promise<void> {
    await this.enqueue(new Date());
  }

  /** Enqueue one fetch when enabled and outside the regular window. Never throws. */
  async enqueue(now: Date): Promise<boolean> {
    if (!offHoursNewsEnabled(process.env) || !offHoursNewsDue(now)) return false;
    try {
      await this.queue.add({}, { removeOnComplete: true, attempts: 2, backoff: { type: 'exponential', delay: 30_000 } });
      this.logger.log('[news-offhours] news fetch enqueued');
      return true;
    } catch (e) {
      this.logger.warn(`[news-offhours] enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
