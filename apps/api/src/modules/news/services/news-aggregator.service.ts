import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NewsSentimentService } from './news-sentiment.service';
import { NewsFilterDto } from '../dto/news.dto';
import { NewsArticle } from '@prisma/client';

interface RSSSource {
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
}

const RSS_SOURCES: RSSSource[] = [
  // Indian market sources
  {
    name: 'Economic Times',
    url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
    category: 'indian',
  },
  {
    name: 'MoneyControl',
    url: 'https://www.moneycontrol.com/rss/MCtopnews.xml',
    category: 'indian',
  },
  {
    name: 'LiveMint',
    url: 'https://www.livemint.com/rss/markets',
    category: 'indian',
  },
  // Global market sources
  {
    name: 'Reuters Business',
    url: 'https://www.reutersagency.com/feed/?best-topics=business-finance',
    category: 'global',
  },
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
  // Company-specific sources
  {
    name: 'ET Earnings',
    url: 'https://economictimes.indiatimes.com/markets/stocks/earnings/rssfeeds/12aborede_2.cms',
    category: 'company',
  },
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
];

@Injectable()
export class NewsAggregatorService {
  private readonly logger = new Logger(NewsAggregatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly sentimentService: NewsSentimentService,
  ) {}

  /**
   * Fetch news from all RSS sources in parallel, deduplicate, analyze
   * sentiment, and save new articles to the database.
   */
  async fetchAllNews(): Promise<number> {
    this.logger.log('Starting news fetch from all RSS sources...');

    const results = await Promise.allSettled(
      RSS_SOURCES.map((source) => this.fetchFromSource(source)),
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

        await this.prisma.newsArticle.create({
          data: {
            title: article.title,
            summary: article.summary || null,
            source: article.source,
            url: article.url,
            category: article.category,
            sentiment: sentimentResult.sentiment,
            sentimentScore: sentimentResult.score,
            relatedSymbols: sentimentResult.relatedSymbols,
            publishedAt: article.publishedAt,
          },
        });

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
  private async fetchFromSource(source: RSSSource): Promise<ParsedArticle[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<any>(source.url, {
          timeout: 10000,
          headers: {
            'User-Agent': 'TD-Automation-News-Bot/1.0',
            Accept: 'application/rss+xml, application/xml, text/xml',
          },
          responseType: 'text',
        }),
      );

      const xml = typeof response.data === 'string'
        ? response.data
        : String(response.data);

      return this.parseRSS(xml, source);
    } catch (error) {
      this.logger.error(
        `Failed to fetch RSS from ${source.name}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return [];
    }
  }

  /**
   * Parse RSS XML using regex to extract <item> elements.
   */
  private parseRSS(xml: string, source: RSSSource): ParsedArticle[] {
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
