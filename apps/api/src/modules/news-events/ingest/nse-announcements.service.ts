import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import { NewsSentimentService } from '../../news/services/news-sentiment.service';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../config';
import { NEWS_INGEST_BUS, type NewsIngestBus } from '../ingest-bus';
import { toIndexedArticle } from '../keys';
import { NseClient } from '../nse-client';
import { SourceHealthBook } from '../source-health';
import { NewsTaggerService } from '../tagging/tagger.service';
import { announcementsDue, NSE_ANNOUNCEMENTS_URL, parseAnnouncements, type ParsedAnnouncement } from './nse-announcements';

export const NSE_ANN_SOURCE = 'NSE Announcements';

/**
 * Spec §4.2 / N3: NSE corporate announcements, polled through the ONE polite NseClient
 * (every 3 min in session, 15 min off-hours). Rows are v2-only: `relatedSymbols = []`
 * (plan "differs" 1) and the exchange's own symbol forced into `instruments`.
 */
@Injectable()
export class NseAnnouncementsService {
  private readonly logger = new Logger(NseAnnouncementsService.name);
  private readonly clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
  private lastRunAt: Date | null = null;
  private running = false;

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly nse: NseClient,
    private readonly prisma: PrismaService,
    private readonly tagger: NewsTaggerService,
    private readonly sentiment: NewsSentimentService,
    @Inject(NEWS_INGEST_BUS) private readonly bus: NewsIngestBus,
    private readonly health: SourceHealthBook,
  ) {}

  @Cron('0 * * * * *', { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    const now = new Date();
    if (!this.cfg.computing || !bootJobsEnabled() || this.running) return;
    if (!announcementsDue(now, this.lastRunAt, this.cfg.nseAnnCadenceMin, this.clock.isTradingDay('NSE', now))) return;
    this.running = true;
    this.lastRunAt = now;
    try {
      await this.runOnce(now);
    } catch (err) {
      this.logger.warn(`[news-ann] run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  async runOnce(now: Date): Promise<number> {
    let parsed: ParsedAnnouncement[];
    try {
      parsed = parseAnnouncements(await this.nse.getJson('NSE corporate-announcements', NSE_ANNOUNCEMENTS_URL));
      this.health.ok(NSE_ANN_SOURCE, parsed.length, now);
    } catch (err) {
      this.health.fail(NSE_ANN_SOURCE, err instanceof Error ? err.message : String(err), now);
      return 0;
    }
    if (parsed.length === 0) return 0;
    const existing = new Set(
      (await this.prisma.newsArticle.findMany({ where: { url: { in: parsed.map((p) => p.url) } }, select: { url: true } })).map((e) => e.url),
    );
    let saved = 0;
    for (const a of parsed.filter((p) => !existing.has(p.url))) {
      try {
        const s = await this.sentiment.analyzeSentiment(a.title, a.summary);
        const { tags, version } = await this.tagger.tag({ title: a.title, summary: a.summary, source: NSE_ANN_SOURCE, category: 'company', forceInstrument: a.symbol });
        const row = await this.prisma.newsArticle.create({
          data: {
            title: a.title,
            summary: a.summary || null,
            source: NSE_ANN_SOURCE,
            url: a.url,
            category: 'company',
            sentiment: s.sentiment,
            sentimentScore: s.score,
            relatedSymbols: [], // plan "differs" 1: legacy readers never see v2-only rows
            publishedAt: a.publishedAt ?? now,
            dateInferred: a.dateInferred,
            instruments: tags.instruments,
            sectors: tags.sectors,
            indices: tags.indices,
            markets: tags.markets,
            tagVersion: version,
          },
        });
        this.bus.publish([toIndexedArticle(row)]);
        saved++;
      } catch (err) {
        this.logger.debug(`[news-ann] skipped ${a.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (saved > 0) this.logger.log(`[news-ann] ${saved} new NSE announcement(s)`);
    return saved;
  }
}
