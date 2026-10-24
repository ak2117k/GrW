export const NEWS_IMPACT_CONFIG = Symbol('NEWS_IMPACT_CONFIG');
export const NEWS_IMPACT_DEFAULT_MODEL = 'claude-haiku-5-5';

export interface NewsImpactConfig {
  /** NEWS_IMPACT_ENABLED (default true): layer 1 clustering / classification / relevance + reactions. */
  enabled: boolean;
  /** NEWS_IMPACT_LLM (default true): layer 2 batched model calls (and so layer 3 alerts / wakes). */
  llm: boolean;
  /** NEWS_IMPACT_MODEL (default claude-haiku-5-5). */
  model: string;
  /** NEWS_IMPACT_DAILY_CALLS (default 60): model calls per IST day, counted from ai_calls job 'news.impact'. */
  dailyCalls: number;
  /** NEWS_IMPACT_MAX_WAIT_MS (default 60000): wait for the shared (non-reserved) model slot, then skip the run. */
  maxWaitMs: number;
  /** NEWS_IMPACT_ALERTS (default true): Telegram ops alert + sentinel wake on a HIGH impact. */
  alerts: boolean;
  /** HUB_OWNER_USER_ID: recorded on the ai_calls row. */
  ownerUserId: string | null;
}

type Env = Record<string, string | undefined>;
const off = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'false' || (v ?? '').trim().toLowerCase() === 'off';
const pos = (v: string | undefined, d: number) => {
  const n = Number((v ?? '').trim());
  return (v ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? n : d;
};

export function parseNewsImpactConfig(env: Env): NewsImpactConfig {
  return {
    enabled: !off(env.NEWS_IMPACT_ENABLED),
    llm: !off(env.NEWS_IMPACT_LLM),
    model: (env.NEWS_IMPACT_MODEL ?? '').trim() || NEWS_IMPACT_DEFAULT_MODEL,
    dailyCalls: Math.floor(pos(env.NEWS_IMPACT_DAILY_CALLS, 60)),
    maxWaitMs: pos(env.NEWS_IMPACT_MAX_WAIT_MS, 60_000),
    alerts: !off(env.NEWS_IMPACT_ALERTS),
    ownerUserId: (env.HUB_OWNER_USER_ID ?? '').trim() || null,
  };
}
