/**
 * The /api/news-ai wire contract — the ONE source of truth for what the web client
 * (apps/web/src/services/newsAi.ts) reads. Dates are Date objects here and ISO strings on the wire.
 * testing/news-ai.wire-fixture.json is the JSON of these responses as the real controller produces
 * them (news-ai.contract.spec.ts keeps it in sync); the web spec parses the same file.
 */
import type { SentimentOverview } from './domain/sentiment-overview';
import type { ArticleRef, StoredBrief, StoredRead } from './news-ai.repository';

/** GET /api/news-ai/brief */
export interface NewsAiBriefResponse {
  /** NEWS_AI switch (false = analysis off). */
  enabled: boolean;
  /** The news-ai tables exist (false = migration not applied yet; everything is empty). */
  ready: boolean;
  /** A brief build (cron or on demand) is running now; the page polls fast while true. */
  building: boolean;
  /** The signed-in user may POST /brief/refresh (the owner or an ADMIN). */
  canRefresh: boolean;
  /** The latest stored brief, or null when none has been built. */
  brief: StoredBrief | null;
  /**
   * The cited articles that still exist in news_articles. A cited id with no entry here was pruned
   * (or never stored): the page shows that citation as unavailable.
   */
  articles: ArticleRef[];
}

/** POST /api/news-ai/brief/refresh → 202. 403 = not owner/admin, 429 = within a minute of the last start. */
export interface NewsAiRefreshResponse {
  /** started = build began; running = one is already going; off = NEWS_AI=off; unavailable = tables missing. */
  status: 'started' | 'running' | 'off' | 'unavailable';
}

/** GET /api/news-ai/reads?ids=a,b,c — ids without a read are absent. */
export interface NewsAiReadsResponse {
  reads: Record<string, StoredRead>;
}

/** GET /api/news-ai/sentiment-overview?hours=24 */
export type NewsAiOverviewResponse = { enabled: boolean; ready: boolean } & SentimentOverview;
