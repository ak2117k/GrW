import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NewsSentimentService } from './news-sentiment.service';
import { NewsFilterDto } from '../dto/news.dto';
import { NewsArticle } from '@prisma/client';
import { FUTURE_PUBDATE_TOLERANCE_MS, NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../../news-events/config';
import { NSE_BROWSER_UA } from '../../news-events/nse-client';
import { SourceHealthBook } from '../../news-events/source-health';
import { NEWS_INGEST_BUS, type NewsIngestBus } from '../../news-events/ingest-bus';
import { toIndexedArticle } from '../../news-events/keys';
import { NewsTaggerService } from '../../news-events/tagging/tagger.service';
import type { ArticleTags } from '../../news-events/types';

export interface RSSSource {
  name: string;
  url: string;
  category: 'indian' | 'global' | 'sector' | 'company';
}

interface ParsedArticle {
  title: string;
  summary: string;
  url: string;
  publishedAt: Date;
  source: string;
  category: 'indian' | 'global' | 'sector' | 'company';
  /** v2 (R6): the pubDate as placed in time; used only when news-events v2 is computing. */
  guard: { publishedAt: Date; dateInferred: boolean };
}

/**
 * Verified by the M0 probe (scripts/news-source-check.ts) on 2026-10-16 from the dev
 * machine with the browser UA and the 15 s timeout: every source here answered HTTP 200
 * with XML, ≥ 1 <item> and a pubDate within 7 days. The Production Gate re-runs the probe
 * on the VPS before `observe`.
 */
const RSS_SOURCES: RSSSource[] = [
  // Indian market sources
  {
    name: 'Economic Times',
    url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
    category: 'indian',
  },
  {
    name: 'LiveMint',
    url: 'https://www.livemint.com/rss/markets',
    category: 'indian',
  },
  // Global market sources
  {
    name: 'CNBC World',
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362',
    category: 'global',
  },
  {
    name: 'MarketWatch',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
    category: 'global',
  },
  // Sector-specific sources
  {
    name: 'ET Auto',
    url: 'https://auto.economictimes.indiatimes.com/rss/topstories',
    category: 'sector',
  },
  {
    name: 'ET Tech',
    url: 'https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms',
    category: 'sector',
  },
  {
    name: 'ET Energy',
    url: 'https://energy.economictimes.indiatimes.com/rss/topstories',
    category: 'sector',
  },
  {
    name: 'ET Pharma',
    url: 'https://health.economictimes.indiatimes.com/rss/topstories',
    category: 'sector',
  },
  {
    name: 'ET BFSI',
    url: 'https://bfsi.economictimes.indiatimes.com/rss/topstories',
    category: 'sector',
  },
  {
    name: 'ET Realty',
    url: 'https://realty.economictimes.indiatimes.com/rss/topstories',
    category: 'sector',
  },
  {
    name: 'Hindu BusinessLine Commodities',
    url: 'https://www.thehindubusinessline.com/markets/commodities/feeder/default.rss',
    category: 'sector',
  },
  {
    name: 'Investing.com Commodities',
    url: 'https://www.investing.com/rss/news_11.rss',
    category: 'sector',
  },
  // Company-specific sources
  {
    name: 'ET Stock News',
    url: 'https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms',
    category: 'company',
  },
  {
    name: 'LiveMint Companies',
    url: 'https://www.livemint.com/rss/companies',
    category: 'company',
  },
  {
    name: 'Business Standard Markets',
    url: 'https://www.business-standard.com/rss/markets-106.rss',
    category: 'company',
  },
  {
    name: 'Business Standard Companies',
    url: 'https://www.business-standard.com/rss/companies-101.rss',
    category: 'company',
  },
  {
    name: 'Hindu BusinessLine Markets',
    url: 'https://www.thehindubusinessline.com/markets/feeder/default.rss',
    category: 'company',
  },
];

/**
 * Removed in M0 (2026-10-16) after failing the probe — kept as a list so a test proves they stay gone.
 * MoneyControl: HTTP 200 but its newest item is from 2016 (a frozen feed). Reuters Business: HTTP 404.
 * ET Earnings: HTTP 404 (malformed id "12aborede_2"); ET's RSS directory lists no earnings feed.
 */
export const REMOVED_SOURCES: readonly string[] = ['MoneyControl', 'Reuters Business', 'ET Earnings'];
export const RSS_FETCH_TIMEOUT_MS = 15_000;

const ZONE_RE = /(?:[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|UT|Z|[ECMP][SD]T|IST))\s*$/i;

/** R6: a pubDate we cannot place in time (missing, unparseable, zone-less, > 10 min ahead) is `fetchedAt` + inferred. */
export function pubDateGuard(raw: string | null, fetchedAt: Date): { publishedAt: Date; dateInferred: boolean } {
  const s = (raw ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  const ms = s ? Date.parse(s) : NaN;
  if (!s || !Number.isFinite(ms) || !ZONE_RE.test(s) || ms - fetchedAt.getTime() > FUTURE_PUBDATE_TOLERANCE_MS) {
    return { publishedAt: fetchedAt, dateInferred: true };
  }
  return { publishedAt: new Date(ms), dateInferred: false };
}

/**
 * Economic Times "Commodities" RSS — crude, gold, silver, natural gas and base
 * metals, published through the MCX evening. Without it the MCX underlyings'
 * news blocks depended on the odd commodity story in the general feeds.
 * Verified 2026-10-12: HTTP 200, text/xml, channel "Commodities-Markets-Economic
 * Times". Override with NEWS_COMMODITIES_RSS_URL, or set it to `off`.
 */
export const ET_COMMODITIES_RSS_URL =
  'https://economictimes.indiatimes.com/markets/commodities/rssfeeds/1808152121.cms';

/** Every RSS source this process fetches. `env` is injectable for tests. */
export function rssSources(env: Record<string, string | undefined> = process.env): RSSSource[] {
  const raw = (env.NEWS_COMMODITIES_RSS_URL ?? '').trim();
  if (raw.toLowerCase() === 'off') return RSS_SOURCES;
  return [...RSS_SOURCES, { name: 'ET Commodities', url: raw || ET_COMMODITIES_RSS_URL, category: 'sector' }];
}

@Injectable()
export class NewsAggregatorService {
  private readonly logger = new Logger(NewsAggregatorService.name);
  /** Test seam: replaces rssSources() when set. */
  sourcesForTest?: RSSSource[];
  /** Test seam: the fetch clock. */
  clock: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly sentimentService: NewsSentimentService,
    @Optional() private readonly health?: SourceHealthBook,
    @Optional() @Inject(NEWS_EVENTS_CONFIG) private readonly cfg?: NewsEventsConfig,
    @Optional() private readonly tagger?: NewsTaggerService,
    @Optional() @Inject(NEWS_INGEST_BUS) private readonly bus?: NewsIngestBus,
  ) {}

  /**
   * Fetch news from all RSS sources in parallel, deduplicate, analyze
   * sentiment, and save new articles to the database.
   */
  async fetchAllNews(): Promise<number> {
    this.logger.log('Starting news fetch from all RSS sources...');
    const fetchedAt = this.clock();

    const results = await Promise.allSettled(
      (this.sourcesForTest ?? rssSources()).map((source) => this.fetchFromSource(source, fetchedAt)),
    );

    let allArticles: ParsedArticle[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allArticles = allArticles.concat(result.value);
      } else {
        this.logger.warn(`RSS fetch failed: ${result.reason}`);
      }
    }

    if (allArticles.length === 0) {
      this.logger.warn('No articles fetched from any source');
      return 0;
    }

    // Deduplicate by URL
    const uniqueUrls = new Map<string, ParsedArticle>();
    for (const article of allArticles) {
      if (!uniqueUrls.has(article.url)) {
        uniqueUrls.set(article.url, article);
      }
    }

    const uniqueArticles = Array.from(uniqueUrls.values());

    // Filter out articles already in DB
    const existingUrls = await this.prisma.newsArticle.findMany({
      where: {
        url: { in: uniqueArticles.map((a) => a.url) },
      },
      select: { url: true },
    });

    const existingUrlSet = new Set(existingUrls.map((e) => e.url));
    const newArticles = uniqueArticles.filter(
      (a) => !existingUrlSet.has(a.url),
    );

    if (newArticles.length === 0) {
      this.logger.log('No new articles to save');
      return 0;
    }

    this.logger.log(`Processing ${newArticles.length} new articles...`);

    let savedCount = 0;

    for (const article of newArticles) {
      try {
        const sentimentResult = await this.sentimentService.analyzeSentiment(
          article.title,
          article.summary,
        );

        const v2 = this.cfg?.computing ? await this.tagV2(article) : null;

        const saved = await this.prisma.newsArticle.create({
          data: {
            title: article.title,
            summary: article.summary || null,
            source: article.source,
            url: article.url,
            category: article.category,
            sentiment: sentimentResult.sentiment,
            sentimentScore: sentimentResult.score,
            relatedSymbols: sentimentResult.relatedSymbols,
            publishedAt: this.cfg?.computing ? article.guard.publishedAt : article.publishedAt,
            ...(v2
              ? {
                  dateInferred: article.guard.dateInferred,
                  instruments: v2.tags.instruments,
                  sectors: v2.tags.sectors,
                  indices: v2.tags.indices,
                  markets: v2.tags.markets,
                  tagVersion: v2.version,
                }
              : {}),
          },
        });

        // v2: push the saved row to the in-memory index right after its insert.
        if (v2) this.bus?.publish([toIndexedArticle(saved)]);
        savedCount++;
      } catch (error) {
        // Skip duplicates or other insert errors
        this.logger.debug(
          `Failed to save article "${article.title}": ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }

    this.logger.log(`Saved ${savedCount} new articles`);
    return savedCount;
  }

  /** v2 tag-once (spec §5). A tagger failure never loses the article: it is saved untagged at version 0. */
  private async tagV2(article: ParsedArticle): Promise<{ tags: ArticleTags; version: number }> {
    const empty = { tags: { instruments: [], sectors: [], indices: [], markets: [] }, version: 0 };
    if (!this.tagger) return empty;
    try {
      return await this.tagger.tag({ title: article.title, summary: article.summary, source: article.source, category: article.category });
    } catch (err) {
      this.logger.warn(`[news-tag] tagging failed for "${article.title.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`);
      return empty;
    }
  }

  /**
   * Get paginated, filtered news articles.
   */
  async getNews(
    filters: NewsFilterDto,
  ): Promise<{ data: NewsArticle[]; total: number; page: number; limit: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, any> = {};

    if (filters.category) {
      where.category = filters.category;
    }

    if (filters.sentiment) {
      where.sentiment = filters.sentiment;
    }

    if (filters.source) {
      where.source = { contains: filters.source, mode: 'insensitive' };
    }

    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { summary: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    if (filters.from || filters.to) {
      where.publishedAt = {};
      if (filters.from) where.publishedAt.gte = new Date(filters.from);
      if (filters.to) where.publishedAt.lte = new Date(filters.to);
    }

    const [data, total] = await Promise.all([
      this.prisma.newsArticle.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.newsArticle.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Get news articles related to a specific stock symbol.
   */
  async getNewsForSymbol(symbol: string): Promise<NewsArticle[]> {
    return this.prisma.newsArticle.findMany({
      where: {
        relatedSymbols: { has: symbol.toUpperCase() },
      },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    });
  }

  /**
   * Get a single article by ID.
   */
  async getArticleById(id: string): Promise<NewsArticle | null> {
    return this.prisma.newsArticle.findUnique({ where: { id } });
  }

  /**
   * Fetch and parse RSS XML from a single source.
   */
  private async fetchFromSource(source: RSSSource, fetchedAt: Date): Promise<ParsedArticle[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<any>(source.url, {
          timeout: RSS_FETCH_TIMEOUT_MS,
          headers: {
            'User-Agent': NSE_BROWSER_UA, // several feeds refuse a bot UA
            Accept: 'application/rss+xml, application/xml, text/xml',
          },
          responseType: 'text',
        }),
      );

      const xml = typeof response.data === 'string'
        ? response.data
        : String(response.data);

      const articles = this.parseRSS(xml, source, fetchedAt);
      this.health?.ok(source.name, articles.length, this.clock());
      return articles;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.health?.fail(source.name, message, this.clock());
      this.logger.error(
        `Failed to fetch RSS from ${source.name}: ${message}`,
      );
      return [];
    }
  }

  /**
   * Parse RSS XML using regex to extract <item> elements.
   */
  private parseRSS(xml: string, source: RSSSource, fetchedAt: Date): ParsedArticle[] {
    const articles: ParsedArticle[] = [];

    // Match all <item>...</item> blocks
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];

      const title = this.extractTag(itemXml, 'title');
      const link = this.extractTag(itemXml, 'link');
      const description = this.extractTag(itemXml, 'description');
      const pubDate = this.extractTag(itemXml, 'pubDate');

      if (!title || !link) continue;

      // Clean HTML tags from description
      const summary = description
        ? description.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim()
        : '';

      let publishedAt: Date;
      try {
        publishedAt = pubDate ? new Date(pubDate) : new Date();
        if (isNaN(publishedAt.getTime())) {
          publishedAt = new Date();
        }
      } catch {
        publishedAt = new Date();
      }

      articles.push({
        title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
        summary: summary.substring(0, 500),
        url: link.trim(),
        publishedAt,
        source: source.name,
        category: source.category,
        guard: pubDateGuard(pubDate, fetchedAt),
      });
    }

    this.logger.debug(
      `Parsed ${articles.length} articles from ${source.name}`,
    );

    return articles;
  }

  /**
   * Extract text content of an XML tag.
   */
  private extractTag(xml: string, tag: string): string | null {
    // Handle CDATA sections
    const cdataRegex = new RegExp(
      `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
      'i',
    );
    const cdataMatch = cdataRegex.exec(xml);
    if (cdataMatch) return cdataMatch[1];

    // Standard tag content
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const tagMatch = regex.exec(xml);
    return tagMatch ? tagMatch[1] : null;
  }
}
