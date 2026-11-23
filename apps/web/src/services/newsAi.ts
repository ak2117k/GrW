import api from './api';

/**
 * Client for the Claude-backed news analysis (apps/api/src/modules/news-ai).
 *
 * The types below mirror the server's wire contract exactly
 * (apps/api/src/modules/news-ai/news-ai.contract.ts; dates arrive as ISO strings).
 * newsAi.spec.ts parses the server's own fixture
 * (news-ai/testing/news-ai.wire-fixture.json, generated from the real controller),
 * so a shape change on either side fails a test.
 *
 * Every call is "best effort": the news page must keep working when these
 * endpoints are missing, slow or failing. 404 (an API without the module)
 * resolves to "nothing yet". 5xx resolves past the global interceptor (no
 * "Server error" toast from a background poll) and is thrown as a NewsAiError
 * the panels render as a quiet message. 401 still goes through the interceptor
 * so token refresh keeps working.
 */

export type AiDirection = 'BULL' | 'BEAR' | 'NEUTRAL' | 'MIXED';
export type AiAffectedDirection = 'BULL' | 'BEAR';
export type AiAffectedKind = 'INDEX' | 'SECTOR' | 'STOCK' | 'COMMODITY' | 'CURRENCY' | 'RATES';
export type AiScoreLabel = 'BULL' | 'BEAR' | 'NEUTRAL';

// ─── GET /api/news-ai/brief ─────────────────────────────────────────────────

export interface AiTone {
  direction: AiDirection;
  summary: string;
  articleIds: string[];
}

export interface AiBriefPoint extends AiTone {
  name: string;
}

export interface AiBriefHolding extends AiTone {
  symbol: string;
}

export interface AiTopStory {
  articleId: string;
  headline: string;
  direction: AiDirection;
  whyItMatters: string;
}

export interface AiWatchItem {
  item: string;
  articleIds: string[];
}

export interface AiBriefBody {
  headline: string;
  indiaTone: AiTone;
  globalTone: AiTone;
  indices: AiBriefPoint[];
  sectors: AiBriefPoint[];
  commodities: AiBriefPoint[];
  holdings: AiBriefHolding[];
  topStories: AiTopStory[];
  watchNext: AiWatchItem[];
  meta?: Record<string, unknown>;
}

export interface AiBrief {
  id: string;
  createdAt: string;
  model: string;
  windowFrom: string;
  windowTo: string;
  brief: AiBriefBody;
}

/** A cited article that still exists (title/url for the citation links). */
export interface AiArticleRef {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface NewsAiBriefResponse {
  /** NEWS_AI switch on the server. */
  enabled: boolean;
  /** The news-ai tables exist (false = not set up yet; everything is empty). */
  ready: boolean;
  /** A brief build is running on the server now. */
  building: boolean;
  /** This user may start a new brief (the owner or an admin). */
  canRefresh: boolean;
  brief: AiBrief | null;
  /** Cited articles that still exist; a cited id missing here was pruned. */
  articles: AiArticleRef[];
}

/** The brief response with the cited articles keyed by id. */
export type AiBriefState = Omit<NewsAiBriefResponse, 'articles'> & { articles: Map<string, AiArticleRef> };

// ─── POST /api/news-ai/brief/refresh (202) ──────────────────────────────────

export type AiRefreshStatus = 'started' | 'running' | 'off' | 'unavailable';

export interface NewsAiRefreshResponse {
  status: AiRefreshStatus;
}

// ─── GET /api/news-ai/reads?ids= ────────────────────────────────────────────

export interface AiAffected {
  kind: AiAffectedKind;
  name: string;
  direction: AiAffectedDirection;
  why: string;
}

export interface AiArticleRead {
  articleId: string;
  model: string;
  createdAt: string;
  direction: AiDirection;
  /** 0..100 */
  strength: number;
  /** 0..100 */
  importance: number;
  takeaway: string;
  affected: AiAffected[];
}

export interface NewsAiReadsResponse {
  reads: Record<string, AiArticleRead>;
}

// ─── GET /api/news-ai/sentiment-overview?hours= ─────────────────────────────

export interface AiOverviewGroup {
  name: string;
  /** Articles naming this instrument, per direction. */
  counts: { BULL: number; BEAR: number };
  /** -100 (all bearish) .. +100 (all bullish). */
  score: number;
  label: AiScoreLabel;
  articleIds: string[];
}

export interface AiSentimentOverview {
  enabled: boolean;
  ready: boolean;
  hours: number;
  from: string;
  to: string;
  total: number;
  overall: {
    counts: { BULL: number; BEAR: number; NEUTRAL: number; MIXED: number };
    /** -100 .. +100 */
    score: number;
    label: AiScoreLabel;
    avgImportance: number;
  };
  /** NIFTY, BANKNIFTY, SENSEX always listed (zero counts included). */
  indices: AiOverviewGroup[];
  sectors: AiOverviewGroup[];
  /** CRUDEOIL, GOLD, SILVER always listed (zero counts included). */
  commodities: AiOverviewGroup[];
}

// ─── Calls ──────────────────────────────────────────────────────────────────

export class NewsAiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'NewsAiError';
  }
}

/** Resolve 2xx, 404 and 5xx; let 401/403/429 reach the shared interceptor. */
const softStatus = (s: number) => (s >= 200 && s < 300) || s === 404 || s >= 500;
/** Refresh also resolves 403 (not owner/admin) and 429 (rate-limited) so they show inline, not as toasts. */
const softRefreshStatus = (s: number) => softStatus(s) || s === 403 || s === 429;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function check(status: number, what: string): void {
  if (status >= 500) throw new NewsAiError(status, `${what} unavailable (${status})`);
}

/** A 2xx body that is not the contract shape (e.g. an HTML error page) is an error, not data. */
function expectShape<T>(ok: boolean, data: unknown, what: string): T {
  if (!ok) throw new NewsAiError(0, `${what}: unexpected response`);
  return data as T;
}

/** What an API without the news-ai module (404) looks like to the page. */
const NOT_DEPLOYED = (): AiBriefState => ({
  enabled: false,
  ready: false,
  building: false,
  canRefresh: false,
  brief: null,
  articles: new Map(),
});

/** Latest AI market brief plus server status. */
export async function getNewsBrief(): Promise<AiBriefState> {
  const res = await api.get('/news-ai/brief', { validateStatus: softStatus });
  if (res.status === 404) return NOT_DEPLOYED();
  check(res.status, 'AI brief');
  const d = res.data as unknown;
  const body = expectShape<NewsAiBriefResponse>(
    isObj(d) && typeof d.enabled === 'boolean' && typeof d.canRefresh === 'boolean' && 'brief' in d && Array.isArray(d.articles),
    d,
    'AI brief',
  );
  return { ...body, articles: new Map(body.articles.map((a) => [a.id, a])) };
}

/**
 * Ask the server to rebuild the brief now (owner/admin only). The server starts
 * the run in the background and answers 202 { status }; the caller then polls
 * GET /brief, which reports `building`. 403 / 429 are thrown as NewsAiError with
 * a message the panel shows inline.
 */
export async function refreshNewsBrief(): Promise<NewsAiRefreshResponse> {
  const res = await api.post('/news-ai/brief/refresh', {}, { validateStatus: softRefreshStatus });
  if (res.status === 404) throw new NewsAiError(404, 'AI brief refresh is not available on this server.');
  if (res.status === 403) throw new NewsAiError(403, 'Only the owner or an admin can start a new brief.');
  if (res.status === 429) throw new NewsAiError(429, 'A brief was just started. Try again in a minute.');
  check(res.status, 'AI brief refresh');
  const d = res.data as unknown;
  return expectShape<NewsAiRefreshResponse>(
    isObj(d) && ['started', 'running', 'off', 'unavailable'].includes(d.status as string),
    d,
    'AI brief refresh',
  );
}

/** Per-article AI reads. Ids without a read yet are simply absent. */
export async function getNewsReads(articleIds: string[]): Promise<AiArticleRead[]> {
  if (articleIds.length === 0) return [];
  const res = await api.get('/news-ai/reads', {
    params: { ids: articleIds.join(',') },
    validateStatus: softStatus,
  });
  if (res.status === 404) return [];
  check(res.status, 'AI reads');
  const d = res.data as unknown;
  const body = expectShape<NewsAiReadsResponse>(isObj(d) && isObj(d.reads), d, 'AI reads');
  return Object.values(body.reads);
}

/** AI sentiment overview for the last `hours`; null when the API has no news-ai module (404). */
export async function getNewsSentimentOverview(hours = 24): Promise<AiSentimentOverview | null> {
  const res = await api.get('/news-ai/sentiment-overview', {
    params: { hours },
    validateStatus: softStatus,
  });
  if (res.status === 404) return null;
  check(res.status, 'AI sentiment');
  const d = res.data as unknown;
  return expectShape<AiSentimentOverview>(
    isObj(d) && typeof d.total === 'number' && isObj(d.overall) && Array.isArray(d.indices) && Array.isArray(d.sectors) && Array.isArray(d.commodities),
    d,
    'AI sentiment',
  );
}
