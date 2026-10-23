/** Signal intake (stream S) settings. Env-only; every knob has a safe default. */
export interface SignalIntakeConfig {
  /** SIGNAL_INTAKE=off stops classification entirely (R still stores every message). Default on. */
  enabled: boolean;
  /** SIGNAL_CLUSTER_MIN — cluster window, minutes (contract default 30). */
  clusterWindowMs: number;
  /** SIGNAL_STRONG_CHANNELS — agreeCount that makes a cluster strong (X reads it; default 3). */
  strongChannels: number;
  /** SIGNAL_PARSE_LLM=off disables the LLM fallback (rule parser only). Default on. */
  llmEnabled: boolean;
  /** SIGNAL_PARSE_MODEL — the cheap model for the fallback. */
  llmModel: string;
  /** SIGNAL_PARSE_LLM_DAILY_CAP — max LLM parse calls per IST day (cache hits are free). */
  llmDailyCap: number;
  /** SIGNAL_PARSE_MAX_WAIT_MS — how long a parse waits for the shared (never the live) model slot. */
  llmMaxWaitMs: number;
  /** SIGNAL_PARSE_LLM_MAX_AGE_MIN — older posts (history backfill) are never sent to the LLM. */
  llmMaxAgeMs: number;
  /** SIGNAL_READY_MAX_AGE_MIN — older posts are stored and clustered but not emitted to X. */
  readyMaxAgeMs: number;
  /** SIGNAL_OUTCOMES=off stops the after-close outcome replay. Default on. */
  outcomesEnabled: boolean;
  /** Whose Angel session fetches the outcome bars (the scorecard / MBM owner). */
  ownerUserId: string | null;
  /** SIGNAL_VISION=off stops reading post images with the model. Default on (inert when the transport cannot take images). */
  visionEnabled: boolean;
  /** SIGNAL_VISION_MODEL — the model for image posts (default: the cheapest image-capable one, haiku). */
  visionModel: string;
  /** SIGNAL_VISION_DAILY_CAP — images per IST day, counted from ai_calls job 'signal.vision' (cache hits are free). */
  visionDailyCap: number;
  /** SIGNAL_VISION_MAX_AGE_MIN — older image posts are never sent to the model. */
  visionMaxAgeMs: number;
}

export const SIGNAL_INTAKE_CONFIG = Symbol('SIGNAL_INTAKE_CONFIG');
export const SIGNAL_PARSE_DEFAULT_MODEL = 'claude-haiku-5-5';
/** Haiku 5.5 reads images (verified over the CLI transport 2026-10-23) and is the cheapest priced model. */
export const SIGNAL_VISION_DEFAULT_MODEL = 'claude-haiku-5-5';

const off = (v: string | undefined) => ['off', 'false', '0', 'no'].includes(String(v ?? '').trim().toLowerCase());
const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

export function parseSignalIntakeConfig(env: Record<string, string | undefined>): SignalIntakeConfig {
  const owner =
    (env.SCORECARD_USER_ID ?? '').trim() ||
    (env.MBM_FEED_USER_ID ?? '').trim() ||
    (env.HUB_OWNER_USER_ID ?? '').trim() ||
    null;
  return {
    enabled: !off(env.SIGNAL_INTAKE),
    clusterWindowMs: int(env.SIGNAL_CLUSTER_MIN, 30, 1, 24 * 60) * 60_000,
    strongChannels: int(env.SIGNAL_STRONG_CHANNELS, 3, 1, 50),
    llmEnabled: !off(env.SIGNAL_PARSE_LLM),
    llmModel: (env.SIGNAL_PARSE_MODEL ?? '').trim() || SIGNAL_PARSE_DEFAULT_MODEL,
    llmDailyCap: int(env.SIGNAL_PARSE_LLM_DAILY_CAP, 150, 0, 10_000),
    llmMaxWaitMs: int(env.SIGNAL_PARSE_MAX_WAIT_MS, 45_000, 1_000, 600_000),
    llmMaxAgeMs: int(env.SIGNAL_PARSE_LLM_MAX_AGE_MIN, 60, 1, 7 * 24 * 60) * 60_000,
    readyMaxAgeMs: int(env.SIGNAL_READY_MAX_AGE_MIN, 15, 1, 24 * 60) * 60_000,
    outcomesEnabled: !off(env.SIGNAL_OUTCOMES),
    ownerUserId: owner,
    visionEnabled: !off(env.SIGNAL_VISION),
    visionModel: (env.SIGNAL_VISION_MODEL ?? '').trim() || SIGNAL_VISION_DEFAULT_MODEL,
    visionDailyCap: int(env.SIGNAL_VISION_DAILY_CAP, 40, 0, 10_000),
    visionMaxAgeMs: int(env.SIGNAL_VISION_MAX_AGE_MIN, 60, 1, 7 * 24 * 60) * 60_000,
  };
}
