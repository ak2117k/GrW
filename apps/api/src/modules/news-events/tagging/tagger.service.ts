import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { NewsSymbolIndexService } from '../../news/services/news-symbol-index.service';
import { NEWS_EVENTS_CONFIG, TAG_VERSION, type NewsEventsConfig } from '../config';
import { MCX_UNDERLYINGS } from '../keys';
import { SectorMapService } from '../sector-map.service';
import type { ArticleTags } from '../types';
import type { AliasRow } from './alias-derivation';
import { NameMatcher } from './name-matcher';
import { tagArticle, type TagInput } from './tag-article';

/**
 * Holds the compiled name matcher; `tag` is CPU-only except the cached listed-symbol set.
 * Until the aliases load, articles are tagged by tickers/keywords only and stamped
 * version 0, so the boot re-tag (RetagService) fixes them once the matcher is ready.
 */
@Injectable()
export class NewsTaggerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NewsTaggerService.name);
  private matcher = new NameMatcher([]);
  private loaded = false;

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly symbolIndex: NewsSymbolIndexService,
    private readonly sectors: SectorMapService,
    private readonly prisma: PrismaService,
  ) {}

  get ready(): boolean {
    return this.loaded;
  }

  onApplicationBootstrap(): void {
    if (this.cfg.computing && bootJobsEnabled()) void this.checkMcxCoverage();
  }

  rebuild(rows: AliasRow[]): void {
    this.matcher = new NameMatcher(rows);
    this.loaded = rows.length > 0;
    this.logger.log(`[news-tag] name matcher: ${this.matcher.size} aliases (~${Math.round(this.matcher.approxBytes() / 1024)} KB)`);
  }

  async tag(a: TagInput): Promise<{ tags: ArticleTags; version: number }> {
    const listed = await this.symbolIndex.symbols();
    return { tags: tagArticle(a, { matcher: this.matcher, listed, sectors: this.sectors }), version: this.loaded ? TAG_VERSION : 0 };
  }

  /** Plan "differs" 4: the live master's MCX names without a keyword mapping, logged once at boot. */
  async checkMcxCoverage(): Promise<void> {
    try {
      const rows = await this.prisma.instrument.findMany({
        where: { exchange: 'MCX', isActive: true, OR: [{ expiry: null }, { expiry: { gte: new Date() } }] },
        select: { name: true },
        distinct: ['name'],
      });
      const missing = rows
        .map((r) => String(r.name ?? '').toUpperCase())
        .filter((n) => n && !MCX_UNDERLYINGS.includes(n))
        .sort();
      if (missing.length > 0) this.logger.warn(`[news-tag] MCX underlying(s) without a news mapping: ${missing.join(', ')}`);
    } catch (err) {
      this.logger.warn(`[news-tag] MCX coverage check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
