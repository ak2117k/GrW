/** Flags (default off): SCORECARD_ENABLED=off|observe|on, NEWS_IDEAS_ENABLED=off|on. */
export type ScorecardMode = 'off' | 'observe' | 'on';

export interface ScorecardConfig {
  /** off: no jobs. observe: compute + store + show on the night report. on: also served to the sentinel. */
  mode: ScorecardMode;
  newsIdeas: boolean;
  /** Whose real Angel positions are scored (SCORECARD_USER_ID, else MBM_FEED_USER_ID, else the first AI_AUTO_EXIT_USER_IDS). */
  ownerUserId: string | null;
  /** Sonnet tier model for the news-ideas call (SENTINEL_MODEL_ROUTINE, else claude-sonnet-5). */
  model: string;
}

export const SCORECARD_CONFIG = Symbol('SCORECARD_CONFIG');

export function parseScorecardConfig(env: Record<string, string | undefined>): ScorecardConfig {
  const raw = (env.SCORECARD_ENABLED ?? '').trim().toLowerCase();
  const mode: ScorecardMode = raw === 'on' || raw === 'true' ? 'on' : raw === 'observe' ? 'observe' : 'off';
  const ni = (env.NEWS_IDEAS_ENABLED ?? '').trim().toLowerCase();
  const firstCsv = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  return {
    mode,
    newsIdeas: ni === 'on' || ni === 'true',
    ownerUserId: (env.SCORECARD_USER_ID ?? '').trim() || (env.MBM_FEED_USER_ID ?? '').trim() || firstCsv(env.AI_AUTO_EXIT_USER_IDS) || null,
    model: (env.SENTINEL_MODEL_ROUTINE ?? '').trim() || 'claude-sonnet-5',
  };
}
