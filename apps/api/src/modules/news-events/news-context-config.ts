/**
 * Position news context v3 config (docs/superpowers/specs/2026-10-16-position-news-context-design.md §14).
 *
 * PURE — imports nothing (news-events.structure.spec.ts asserts it). Exact trimmed lower-case words
 * only: a typo is `false` / `off` and is reported once at boot. v3 *computes* only when v2 computes
 * (`NEWS_EVENTS_V2_ENABLED=observe|true`) and *renders* only when v2 renders (`true`) and v3 is `true`.
 */

export type NewsContextMode = 'false' | 'observe' | 'true';
export type CuratorMode = 'off' | 'propose' | 'auto';
export const NEWS_CONTEXT_CONFIG = 'NEWS_CONTEXT_CONFIG';

export interface NewsContextConfig {
  mode: NewsContextMode;
  /** v2 computes (observe|true) AND v3 is observe|true. */
  computing: boolean;
  /** v2 renders (true) AND v3 is true. */
  rendering: boolean;
  curator: CuratorMode;
  nightMaxCalls: number;
  nightMaxInputTokens: number;
  profileMaxBuildsPerDay: number;
  profileRefreshDays: number;
  problems: string[];
}

/** Ladder v3 (spec §4.5). */
export const V3_LAYER_CAPS = { instrument: 8, driver: 2, sector: 3, index: 2, market: 2 } as const;
export const V3_MAX_HEADLINES = 8;
export const WHY_MAX = 40;
export const NEWS_IGNORED_MAX = 3;
export const NEWS_IGNORED_WHY_MAX = 120;
export const FEEDBACK_REASON_MAX = 300;
export const BLAST_RADIUS_MAX = 0.003; // §4.2: > 0.3 % of 30 d ⇒ generic
export const BLAST_WINDOW_DAYS = 30;
export const GENERIC_WORD_SHARE = 0.005; // §5.1: ≥ 0.5 % of EQUITY_L names
export const CONTEXT_WINDOW_TOKENS = 6; // §5.2: ±6 tokens
export const MATCHER_MAX_PER_KEY = 50;
export const CURATOR_MAX_PROPOSALS = 10;
export const CURATOR_MAX_APPLIED = 5;
export const CURATOR_MIN_SUPPORT = 2;
export const CURATOR_MAX_RECALL_DROP_PP = 0.5;
export const CURATOR_MAX_BLAST_SHARE = 0.02;
export const AUDIT_MAX_CALLS = 15;
export const AUDIT_MAX_HEADLINES = 40;
export const AUDIT_MARKET_SAMPLE = 60;
export const PREBUILD_MAX_PER_NIGHT = 15;
export const NIGHT_DEADLINE_IST = '07:30';
export const SOURCE_DROP_NIGHTS = 3;

function word<T extends string>(raw: string | undefined, allowed: readonly T[], off: T, key: string, problems: string[]): T {
  const v = (raw ?? '').trim().toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  if (v !== '') problems.push(`${key}="${raw}" is not ${allowed.join('|')} — treated as ${off}`);
  return off;
}

export function parseNewsContextConfig(env: Record<string, string | undefined>): NewsContextConfig {
  const problems: string[] = [];
  const mode = word<NewsContextMode>(env.NEWS_CONTEXT_V3, ['false', 'observe', 'true'], 'false', 'NEWS_CONTEXT_V3', problems);
  const curator = word<CuratorMode>(env.NEWS_CURATOR_MODE, ['off', 'propose', 'auto'], 'off', 'NEWS_CURATOR_MODE', problems);
  const v2 = (env.NEWS_EVENTS_V2_ENABLED ?? '').trim().toLowerCase(); // v2's own exact-word rule; v2 reports its typos
  const int = (key: string, def: number, min: number, max: number): number => {
    const v = env[key];
    if (v === undefined || v.trim() === '') return def;
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key}=${v} is out of range [${min}, ${max}] — using ${def}`);
      return def;
    }
    return n;
  };
  return {
    mode,
    computing: (v2 === 'observe' || v2 === 'true') && mode !== 'false',
    rendering: v2 === 'true' && mode === 'true',
    curator,
    nightMaxCalls: int('NEWS_LLM_NIGHT_MAX_CALLS', 40, 0, 200),
    nightMaxInputTokens: int('NEWS_LLM_NIGHT_MAX_INPUT_TOKENS', 400_000, 0, 5_000_000),
    profileMaxBuildsPerDay: int('NEWS_PROFILE_MAX_BUILDS_PER_DAY', 20, 0, 200),
    profileRefreshDays: int('NEWS_PROFILE_REFRESH_DAYS', 90, 7, 365),
    problems,
  };
}

export function newsContextBootLine(c: NewsContextConfig): string {
  const state = c.rendering ? 'rendering' : c.computing ? 'computing' : 'idle';
  return (
    `[news-ctx] v3=${c.mode} (${state}) curator=${c.curator} caps=calls ${c.nightMaxCalls}/night, ` +
    `input ${c.nightMaxInputTokens}/night, profiles ${c.profileMaxBuildsPerDay}/day refresh ${c.profileRefreshDays}d`
  );
}
