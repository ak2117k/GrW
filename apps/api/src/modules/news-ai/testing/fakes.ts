import type { ArticleForRead, OwnerHolding, ReadArticle } from '../domain/news-ai.inputs';
import type { NewsAiReadReply } from '../domain/news-ai.validate';
import { parseNewsAiConfig, type NewsAiConfig } from '../news-ai.config';
import type { ArticleRef, NewsAiStore, StoredBrief, StoredRead } from '../news-ai.repository';
import type { NewsAiLlm } from '../services/news-ai-llm.service';

/** Test-only fakes for the news-ai ports (no DB, no AI). */

export interface FakeArticle extends Omit<ArticleForRead, 'attempts'> {
  fetchedAt: Date;
  filtered?: boolean;
  url?: string;
}

export const cfg = (over: Partial<NewsAiConfig> = {}): NewsAiConfig => ({ ...parseNewsAiConfig({}), ...over });

export function article(id: string, minsAgo: number, now: Date, over: Partial<FakeArticle> = {}): FakeArticle {
  const t = new Date(now.getTime() - minsAgo * 60_000);
  return {
    id,
    title: `title ${id}`,
    summary: 'summary',
    source: 'ET',
    category: 'indian',
    publishedAt: t,
    fetchedAt: t,
    relatedSymbols: [],
    instruments: [],
    sectors: [],
    indices: [],
    markets: [],
    ...over,
  };
}

/** In-memory store with the SAME selection rules as NewsAiRepository's SQL. */
export class FakeStore implements NewsAiStore {
  articles: FakeArticle[] = [];
  reads = new Map<string, StoredRead>();
  failures = new Map<string, { attempts: number; lastError: string }>();
  briefs: StoredBrief[] = [];
  holdings: OwnerHolding[] = [];
  extraReads: ReadArticle[] = [];
  saveReadError: Error | null = null;
  ready = true;

  async tablesReady(): Promise<boolean> {
    return this.ready;
  }

  async readCandidates(since: Date, maxAttempts: number, limit: number): Promise<ArticleForRead[]> {
    return this.articles
      .filter((a) => a.fetchedAt >= since && !a.filtered && !this.reads.has(a.id) && (this.failures.get(a.id)?.attempts ?? 0) < maxAttempts)
      .map(({ fetchedAt: _f, filtered: _x, url: _u, ...a }) => ({ ...a, attempts: this.failures.get(a.id)?.attempts ?? 0 }))
      .sort((a, b) => a.attempts - b.attempts || b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, limit);
  }
  async saveRead(articleId: string, model: string, read: NewsAiReadReply): Promise<void> {
    if (this.saveReadError) throw this.saveReadError;
    if (!this.reads.has(articleId)) this.reads.set(articleId, { articleId, model, createdAt: new Date(), ...read });
  }
  async recordFailure(articleId: string, error: string): Promise<void> {
    const f = this.failures.get(articleId);
    this.failures.set(articleId, { attempts: (f?.attempts ?? 0) + 1, lastError: error });
  }
  async readsSince(since: Date): Promise<ReadArticle[]> {
    const fromStore = [...this.reads.values()].flatMap((r) => {
      const a = this.articles.find((x) => x.id === r.articleId);
      if (!a || a.filtered || a.publishedAt < since) return [];
      return [{ id: a.id, title: a.title, source: a.source, publishedAt: a.publishedAt, direction: r.direction, strength: r.strength, importance: r.importance, takeaway: r.takeaway, affected: r.affected, readAt: r.createdAt }];
    });
    return [...fromStore, ...this.extraReads.filter((r) => r.publishedAt >= since)];
  }
  async readsFor(ids: string[]): Promise<StoredRead[]> {
    return ids.flatMap((id) => (this.reads.has(id) ? [this.reads.get(id)!] : []));
  }
  async ownerHoldings(): Promise<OwnerHolding[]> {
    return this.holdings;
  }
  async saveBrief(b: Omit<StoredBrief, 'id' | 'createdAt'>): Promise<StoredBrief> {
    const s = { ...b, id: `b${this.briefs.length + 1}`, createdAt: new Date() };
    this.briefs.push(s);
    return s;
  }
  async latestBrief(): Promise<StoredBrief | null> {
    return this.briefs.at(-1) ?? null;
  }
  async latestReadAt(): Promise<Date | null> {
    const ts = [...this.reads.values()].map((r) => r.createdAt.getTime());
    return ts.length ? new Date(Math.max(...ts)) : null;
  }
  async articleRefs(ids: string[]): Promise<ArticleRef[]> {
    return this.articles.filter((a) => ids.includes(a.id)).map((a) => ({ id: a.id, title: a.title, source: a.source, url: a.url ?? '', publishedAt: a.publishedAt }));
  }
  async prune(): Promise<void> {}
}

export class FakeLlm implements NewsAiLlm {
  readMessages: string[] = [];
  briefMessages: string[] = [];
  constructor(
    public readReply: (msg: string) => unknown = () => ({ direction: 'BULL', strength: 60, importance: 70, takeaway: 'ok', affected: [] }),
    public briefReply: (msg: string) => unknown = () => ({}),
  ) {}
  async readArticle(msg: string): Promise<unknown> {
    this.readMessages.push(msg);
    return this.readReply(msg);
  }
  async writeBrief(msg: string): Promise<unknown> {
    this.briefMessages.push(msg);
    return this.briefReply(msg);
  }
}
