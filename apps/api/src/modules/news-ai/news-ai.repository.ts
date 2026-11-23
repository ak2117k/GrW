import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ArticleForRead, OwnerHolding, ReadArticle } from './domain/news-ai.inputs';
import type { AffectedItem, NewsAiReadReply, NewsBriefBody } from './domain/news-ai.validate';
import type { Direction } from './domain/news-ai.schemas';

export interface StoredRead extends NewsAiReadReply {
  articleId: string;
  model: string;
  createdAt: Date;
}

export interface StoredBrief {
  id: string;
  createdAt: Date;
  model: string;
  windowFrom: Date;
  windowTo: Date;
  brief: NewsBriefBody & { meta?: Record<string, unknown> };
}

/** The storage the services use (a fake in tests). */
export interface NewsAiStore {
  /** All three news-ai tables exist (migration 202611241100_news_ai applied). */
  tablesReady(): Promise<boolean>;
  readCandidates(since: Date, maxAttempts: number, limit: number): Promise<ArticleForRead[]>;
  saveRead(articleId: string, model: string, read: NewsAiReadReply): Promise<void>;
  recordFailure(articleId: string, error: string): Promise<void>;
  readsSince(since: Date): Promise<ReadArticle[]>;
  readsFor(articleIds: string[]): Promise<StoredRead[]>;
  ownerHoldings(userId: string): Promise<OwnerHolding[]>;
  saveBrief(b: Omit<StoredBrief, 'id' | 'createdAt'>): Promise<StoredBrief>;
  latestBrief(): Promise<StoredBrief | null>;
  latestReadAt(): Promise<Date | null>;
  articleRefs(ids: string[]): Promise<ArticleRef[]>;
  prune(before: Date): Promise<void>;
}

/** What the page needs to render a citation. */
export interface ArticleRef {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: Date;
}
export const NEWS_AI_STORE = Symbol('NEWS_AI_STORE');

export const NEWS_AI_TABLES = ['news_ai_reads', 'news_ai_read_failures', 'news_briefs'] as const;
/** While the tables are missing, look again at most this often (deploy.sh runs `prisma migrate deploy`). */
export const TABLES_RECHECK_MS = 10 * 60_000;

const parseAffected = (v: unknown): AffectedItem[] => {
  const raw = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(raw) ? (raw as AffectedItem[]) : [];
};

/**
 * Raw SQL over news_ai_reads / news_ai_read_failures / news_briefs (none is a tenant table) and
 * news_articles. trade_trackers IS a tenant table: its one query carries its own "userId" guard.
 *
 * news_articles.filtered (the relevance filter, migration 202611241000) may not exist yet on a
 * given database: the column is looked up once in information_schema and, when present, every
 * read here skips filtered = true rows.
 */
@Injectable()
export class NewsAiRepository implements NewsAiStore {
  private readonly logger = new Logger(NewsAiRepository.name);
  private filteredColumn: Promise<boolean> | null = null;
  private tables: { ok: boolean; at: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * True once all three news-ai tables exist. A yes is cached for good; a no (migration not applied
   * yet) is logged once and looked up again at most every 10 min, so the 2-min read job, the brief
   * job and the page endpoints stay idle and quiet instead of failing on every call.
   */
  async tablesReady(now = Date.now()): Promise<boolean> {
    if (this.tables && (this.tables.ok || now - this.tables.at < TABLES_RECHECK_MS)) return this.tables.ok;
    let ok = false;
    try {
      const r = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
        [...NEWS_AI_TABLES],
      );
      ok = Number(r[0]?.n ?? 0) === NEWS_AI_TABLES.length;
    } catch (e) {
      this.logger.warn(`[news-ai] table lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!ok && (this.tables === null || this.tables.ok)) {
      this.logger.warn('[news-ai] tables missing: apply migration 202611241100_news_ai (prisma migrate deploy); news-ai stays idle until then');
    }
    this.tables = { ok, at: now };
    return ok;
  }

  /** `AND a."filtered" IS NOT TRUE` when the column exists, else ''. Re-checked after a failed lookup. */
  async visibleClause(alias = 'a'): Promise<string> {
    this.filteredColumn ??= this.prisma
      .$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'news_articles' AND column_name = 'filtered'`,
      )
      .then((r) => Number(r[0]?.n ?? 0) > 0)
      .catch((e: unknown) => {
        this.filteredColumn = null;
        this.logger.warn(`[news-ai] filtered-column lookup failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      });
    return (await this.filteredColumn) ? ` AND ${alias}."filtered" IS NOT TRUE` : '';
  }

  async readCandidates(since: Date, maxAttempts: number, limit: number): Promise<ArticleForRead[]> {
    const vis = await this.visibleClause('a');
    const rows = await this.prisma.$queryRawUnsafe<Array<Omit<ArticleForRead, 'attempts'> & { attempts: number | null }>>(
      `SELECT a."id", a."title", a."summary", a."source", a."category", a."publishedAt", a."relatedSymbols",
              a."instruments", a."sectors", a."indices", a."markets", COALESCE(f."attempts", 0)::int AS "attempts"
         FROM "news_articles" a
         LEFT JOIN "news_ai_reads" r ON r."article_id" = a."id"
         LEFT JOIN "news_ai_read_failures" f ON f."article_id" = a."id"
        WHERE a."fetchedAt" >= $1
          AND r."article_id" IS NULL
          AND COALESCE(f."attempts", 0) < $2${vis}
        ORDER BY COALESCE(f."attempts", 0) ASC, a."publishedAt" DESC
        LIMIT $3`,
      since,
      maxAttempts,
      limit,
    );
    return rows.map((r) => ({ ...r, attempts: Number(r.attempts ?? 0) }));
  }

  async saveRead(articleId: string, model: string, read: NewsAiReadReply): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "news_ai_reads" ("id", "article_id", "model", "direction", "strength", "importance", "takeaway", "affected", "created_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
       ON CONFLICT ("article_id") DO NOTHING`,
      randomUUID(),
      articleId,
      model,
      read.direction,
      read.strength,
      read.importance,
      read.takeaway,
      JSON.stringify(read.affected),
    );
  }

  async recordFailure(articleId: string, error: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "news_ai_read_failures" ("article_id", "attempts", "last_error", "updated_at")
       VALUES ($1, 1, $2, now())
       ON CONFLICT ("article_id") DO UPDATE SET "attempts" = "news_ai_read_failures"."attempts" + 1,
         "last_error" = EXCLUDED."last_error", "updated_at" = now()`,
      articleId,
      error.slice(0, 500),
    );
  }

  async readsSince(since: Date): Promise<ReadArticle[]> {
    const vis = await this.visibleClause('a');
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ id: string; title: string; source: string; publishedAt: Date; direction: Direction; strength: number; importance: number; takeaway: string; affected: unknown; readAt: Date }>
    >(
      `SELECT a."id", a."title", a."source", a."publishedAt", r."direction", r."strength", r."importance",
              r."takeaway", r."affected", r."created_at" AS "readAt"
         FROM "news_ai_reads" r
         JOIN "news_articles" a ON a."id" = r."article_id"
        WHERE a."publishedAt" >= $1${vis}
        ORDER BY r."importance" DESC, a."publishedAt" DESC
        LIMIT 2000`,
      since,
    );
    return rows.map((r) => ({ ...r, strength: Number(r.strength), importance: Number(r.importance), affected: parseAffected(r.affected) }));
  }

  async readsFor(articleIds: string[]): Promise<StoredRead[]> {
    if (articleIds.length === 0) return [];
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ articleId: string; model: string; direction: Direction; strength: number; importance: number; takeaway: string; affected: unknown; createdAt: Date }>
    >(
      `SELECT "article_id" AS "articleId", "model", "direction", "strength", "importance", "takeaway", "affected", "created_at" AS "createdAt"
         FROM "news_ai_reads" WHERE "article_id" = ANY($1::text[])`,
      articleIds,
    );
    return rows.map((r) => ({ ...r, strength: Number(r.strength), importance: Number(r.importance), affected: parseAffected(r.affected) }));
  }

  async ownerHoldings(userId: string): Promise<OwnerHolding[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ symbol: string; exchange: string; kind: string; qty: number; pnl: number | null }>>(
      `SELECT "symbol", "exchange", "kind", "qty", "pnl"
         FROM "trade_trackers"
        WHERE "userId" = $1 AND "status" = 'OPEN'
        ORDER BY "kind", "symbol"
        LIMIT 200`,
      userId,
    );
    return rows.map((r) => ({ ...r, qty: Number(r.qty), pnl: r.pnl == null ? null : Number(r.pnl) }));
  }

  async saveBrief(b: Omit<StoredBrief, 'id' | 'createdAt'>): Promise<StoredBrief> {
    const id = randomUUID();
    const rows = await this.prisma.$queryRawUnsafe<Array<{ createdAt: Date }>>(
      `INSERT INTO "news_briefs" ("id", "created_at", "model", "window_from", "window_to", "brief")
       VALUES ($1, now(), $2, $3, $4, $5::jsonb) RETURNING "created_at" AS "createdAt"`,
      id,
      b.model,
      b.windowFrom,
      b.windowTo,
      JSON.stringify(b.brief),
    );
    return { ...b, id, createdAt: rows[0]?.createdAt ?? new Date() };
  }

  async latestBrief(): Promise<StoredBrief | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; createdAt: Date; model: string; windowFrom: Date; windowTo: Date; brief: unknown }>>(
      `SELECT "id", "created_at" AS "createdAt", "model", "window_from" AS "windowFrom", "window_to" AS "windowTo", "brief"
         FROM "news_briefs" ORDER BY "created_at" DESC LIMIT 1`,
    );
    const r = rows[0];
    if (!r) return null;
    return { ...r, brief: (typeof r.brief === 'string' ? JSON.parse(r.brief) : r.brief) as StoredBrief['brief'] };
  }

  async latestReadAt(): Promise<Date | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ at: Date | null }>>(`SELECT MAX("created_at") AS "at" FROM "news_ai_reads"`);
    return rows[0]?.at ?? null;
  }

  async articleRefs(ids: string[]): Promise<ArticleRef[]> {
    if (ids.length === 0) return [];
    return this.prisma.$queryRawUnsafe<ArticleRef[]>(
      `SELECT "id", "title", "source", "url", "publishedAt" FROM "news_articles" WHERE "id" = ANY($1::text[])`,
      ids,
    );
  }

  /** Retention: AI reads / failures / briefs older than `before` (the articles themselves are pruned elsewhere). */
  async prune(before: Date): Promise<void> {
    await this.prisma.$executeRawUnsafe(`DELETE FROM "news_ai_reads" WHERE "created_at" < $1`, before);
    await this.prisma.$executeRawUnsafe(`DELETE FROM "news_ai_read_failures" WHERE "updated_at" < $1`, before);
    await this.prisma.$executeRawUnsafe(`DELETE FROM "news_briefs" WHERE "created_at" < $1`, before);
  }
}
