import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { NEWS_EVENTS_CONFIG, TAG_VERSION, type NewsEventsConfig } from '../config';
import { NEWS_INGEST_BUS, type NewsIngestBus } from '../ingest-bus';
import { toIndexedArticle } from '../keys';
import { NewsTaggerService } from '../tagging/tagger.service';
import type { ArticleTags, IndexedArticle } from '../types';

export const RETAG_WINDOW_MS = 48 * 3_600_000;
const PAGE = 200;
const WAIT_FOR_ALIASES_MS = 120_000;
const WAIT_POLL_MS = 5_000;
const UNTAGGED: ArticleTags = { instruments: [], sectors: [], indices: [], markets: [] };

/**
 * Spec §5.6: on boot, re-tag the last 48 h with the current matcher version (waits up
 * to 2 min for the aliases) and republish the re-tagged rows on the ingest bus.
 */
@Injectable()
export class RetagService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetagService.name);

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly prisma: PrismaService,
    private readonly tagger: NewsTaggerService,
    @Inject(NEWS_INGEST_BUS) private readonly bus: NewsIngestBus,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.computing || !bootJobsEnabled()) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (this.tagger.ready || Date.now() - started > WAIT_FOR_ALIASES_MS) {
        clearInterval(timer);
        if (!this.tagger.ready) this.logger.warn('[news-tag] re-tag skipped: no company-name aliases loaded after 2 min');
        void this.run(new Date()).catch((err) => this.logger.warn(`[news-tag] re-tag failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }, WAIT_POLL_MS);
    timer.unref?.();
  }

  async run(now: Date): Promise<number> {
    if (!this.tagger.ready) return 0;
    let done = 0;
    for (;;) {
      const rows = await this.prisma.newsArticle.findMany({
        where: { publishedAt: { gte: new Date(now.getTime() - RETAG_WINDOW_MS) }, tagVersion: { lt: TAG_VERSION } },
        select: { id: true, title: true, summary: true, source: true, category: true, sentiment: true, publishedAt: true, fetchedAt: true, dateInferred: true },
        orderBy: { publishedAt: 'asc' },
        take: PAGE,
      });
      if (rows.length === 0) break;
      const out: IndexedArticle[] = [];
      for (const r of rows) {
        let tags = UNTAGGED;
        try {
          tags = (await this.tagger.tag({ title: r.title, summary: r.summary ?? '', source: r.source, category: r.category })).tags;
        } catch (err) {
          this.logger.warn(`[news-tag] re-tag failed for ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Stamped TAG_VERSION whatever the outcome, so every page leaves the query and the loop terminates.
        const saved = await this.prisma.newsArticle.update({ where: { id: r.id }, data: { ...tags, tagVersion: TAG_VERSION } });
        out.push(toIndexedArticle(saved));
      }
      this.bus.publish(out);
      done += rows.length;
    }
    if (done > 0) this.logger.log(`[news-tag] re-tagged ${done} article(s) from the last 48 h to v${TAG_VERSION}`);
    return done;
  }
}
