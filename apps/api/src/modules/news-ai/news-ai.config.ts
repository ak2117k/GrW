export const NEWS_AI_CONFIG = Symbol('NEWS_AI_CONFIG');

/** `ai_calls.job` labels (config/ai-agents.json: news.sentiment -> reading, news.brief -> background). */
export const NEWS_SENTIMENT_JOB = 'news.sentiment';
export const NEWS_BRIEF_JOB = 'news.brief';

/** Sonnet tier (Sonnet 5.5 on Vertex via vertexModelId). */
export const NEWS_AI_READ_DEFAULT_MODEL = 'claude-sonnet-5';
/** Opus tier (Opus 5.5 on Vertex). */
export const NEWS_AI_BRIEF_DEFAULT_MODEL = 'claude-opus-5';

export interface NewsAiConfig {
  /** NEWS_AI=off|on (default on): both the per-article read and the page brief. */
  enabled: boolean;
  /** NEWS_AI_READ_MODEL (default claude-sonnet-5). */
  readModel: string;
  /** NEWS_AI_BRIEF_MODEL (default claude-opus-5). */
  briefModel: string;
  /** NEWS_AI_BATCH (default 24): articles read per 2-min tick. */
  batch: number;
  /** NEWS_AI_CONCURRENCY (default 3): parallel per-article calls inside one tick. */
  concurrency: number;
  /** Total attempts per article: the first read + at most 2 retries. */
  maxAttempts: number;
  /** NEWS_AI_LOOKBACK_HOURS (default 24): only articles fetched this recently are read. */
  lookbackHours: number;
  /** NEWS_AI_BRIEF_MAX_ARTICLES (default 80): cap on articles sent to the brief. */
  briefMaxArticles: number;
  /** NEWS_AI_BRIEF_MIN_RECENT (default 30): below this many reads in the last 6 h the brief widens to 24 h. */
  briefMinRecent: number;
  /** NEWS_AI_MAX_WAIT_MS (default 120000): shared-slot wait when the transport is the CLI. */
  maxWaitMs: number;
  /** HUB_OWNER_USER_ID: whose holdings / positions the brief covers; recorded on ai_calls. */
  ownerUserId: string | null;
}

type Env = Record<string, string | undefined>;
const isOff = (v: string | undefined) => ['off', 'false', '0', 'no'].includes((v ?? '').trim().toLowerCase());
const posInt = (v: string | undefined, d: number, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number((v ?? '').trim());
  return (v ?? '').trim() !== '' && Number.isFinite(n) && n >= 1 ? Math.min(max, Math.floor(n)) : d;
};

export function parseNewsAiConfig(env: Env): NewsAiConfig {
  return {
    enabled: !isOff(env.NEWS_AI),
    readModel: (env.NEWS_AI_READ_MODEL ?? '').trim() || NEWS_AI_READ_DEFAULT_MODEL,
    briefModel: (env.NEWS_AI_BRIEF_MODEL ?? '').trim() || NEWS_AI_BRIEF_DEFAULT_MODEL,
    batch: posInt(env.NEWS_AI_BATCH, 24, 200),
    concurrency: posInt(env.NEWS_AI_CONCURRENCY, 3, 16),
    maxAttempts: 3,
    lookbackHours: posInt(env.NEWS_AI_LOOKBACK_HOURS, 24, 168),
    briefMaxArticles: posInt(env.NEWS_AI_BRIEF_MAX_ARTICLES, 80, 300),
    briefMinRecent: posInt(env.NEWS_AI_BRIEF_MIN_RECENT, 30, 300),
    maxWaitMs: posInt(env.NEWS_AI_MAX_WAIT_MS, 120_000),
    ownerUserId: (env.HUB_OWNER_USER_ID ?? '').trim() || null,
  };
}
