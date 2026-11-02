/**
 * Chart-screenshot setup reader (owner 2026-11-02). Env-only; every knob has a safe default.
 *
 * IMAGE_SETUPS          off | observe | signal (default observe: store the read only).
 * IMAGE_SETUP_CHANNELS  telegram_channels.id list (comma); default only "Stock Wale Bhaiyaa Learning Group".
 */
export type ImageSetupMode = 'off' | 'observe' | 'signal';

export interface ImageSetupConfig {
  mode: ImageSetupMode;
  channels: ReadonlySet<string>;
  /** IMAGE_SETUP_MODEL — the vision model (default haiku: on the 2026-11-02 backfill it read the axis labels as well as sonnet, and kept two position tools apart better). */
  model: string;
  /** IMAGE_SETUP_DAILY_CAP — reads per IST day (telegram_image_reads rows that called the model). */
  dailyCap: number;
  /** IMAGE_SETUP_MIN_GAP_SEC — at least this long between two reads (rate limit). */
  minGapMs: number;
  /** IMAGE_SETUP_MAX_AGE_MIN — older posts are not read (a restart replaying history). */
  maxAgeMs: number;
  /** IMAGE_SETUP_MAX_WAIT_MS — how long a read waits for the shared (never the live) model slot. */
  maxWaitMs: number;
  /** IMAGE_SETUP_QUEUE_MAX — pending reads kept in memory; more are dropped (logged). */
  queueMax: number;
  /** IMAGE_SETUP_FRESH_MIN — signal mode: the screenshot clock at most this many minutes before the post. */
  freshMaxLagMin: number;
  /** IMAGE_SETUP_MAX_DRIFT_PCT — signal mode: the current price within this % of the entry. */
  maxDriftPct: number;
  /** SIGNAL_ALLOW_OPTION_SELL=true (the signal trader's own switch): without it a SELL CE/PE stays observe. */
  allowOptionSell: boolean;
}

export const IMAGE_SETUP_CONFIG = Symbol('IMAGE_SETUP_CONFIG');
/** "Stock Wale Bhaiyaa Learning Group" — posts its trades as position-tool screenshots. */
export const IMAGE_SETUP_DEFAULT_CHANNELS = ['cmvkyxugk01kutd01df3yclc6'];
export const IMAGE_SETUP_DEFAULT_MODEL = 'claude-haiku-5-5';

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

export function parseImageSetupConfig(env: Record<string, string | undefined>): ImageSetupConfig {
  const m = String(env.IMAGE_SETUPS ?? '').trim().toLowerCase();
  const mode: ImageSetupMode = m === 'off' || m === 'false' || m === '0' ? 'off' : m === 'signal' ? 'signal' : 'observe';
  const listed = String(env.IMAGE_SETUP_CHANNELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    mode,
    channels: new Set(listed.length ? listed : IMAGE_SETUP_DEFAULT_CHANNELS),
    model: (env.IMAGE_SETUP_MODEL ?? '').trim() || IMAGE_SETUP_DEFAULT_MODEL,
    dailyCap: int(env.IMAGE_SETUP_DAILY_CAP, 40, 0, 10_000),
    minGapMs: int(env.IMAGE_SETUP_MIN_GAP_SEC, 15, 0, 3600) * 1000,
    maxAgeMs: int(env.IMAGE_SETUP_MAX_AGE_MIN, 60, 1, 7 * 24 * 60) * 60_000,
    maxWaitMs: int(env.IMAGE_SETUP_MAX_WAIT_MS, 90_000, 1_000, 600_000),
    queueMax: int(env.IMAGE_SETUP_QUEUE_MAX, 50, 1, 1000),
    freshMaxLagMin: int(env.IMAGE_SETUP_FRESH_MIN, 10, 1, 120),
    maxDriftPct: int(env.IMAGE_SETUP_MAX_DRIFT_PCT, 15, 1, 100),
    allowOptionSell: env.SIGNAL_ALLOW_OPTION_SELL === 'true',
  };
}
