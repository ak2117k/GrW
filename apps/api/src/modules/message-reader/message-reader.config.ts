/** AI message reader settings. Env-only; every knob has a safe default (the reader is off unless switched on). */
export type ReaderMode = 'off' | 'shadow' | 'on';

export interface MessageReaderConfig {
  /** MESSAGE_READER — off (default) | shadow (read + store, judge blind) | on (judge sees readings). Unknown = off. */
  mode: ReaderMode;
  /** MESSAGE_READER_MODEL — the reading model. */
  model: string;
  /** MESSAGE_READER_PACKET_MS — time box for building the market-data packet. */
  packetMs: number;
  /** MESSAGE_READER_TIMEOUT_MS — the AI call timeout. */
  timeoutMs: number;
  /** MESSAGE_READER_MAX_AGE_MIN — posts older than this at dequeue are stored STALE, not read. */
  maxAgeMin: number;
  /** One retry is allowed only while the post is younger than this (minutes). Fixed. */
  retryMaxAgeMin: 5;
}

export const MESSAGE_READER_CONFIG = Symbol('MESSAGE_READER_CONFIG');
export const MESSAGE_READER_DEFAULT_MODEL = 'claude-sonnet-5';

const MODES: readonly ReaderMode[] = ['off', 'shadow', 'on'];

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

export function parseMessageReaderConfig(env: Record<string, string | undefined>): MessageReaderConfig {
  const raw = String(env.MESSAGE_READER ?? '').trim().toLowerCase() as ReaderMode;
  return {
    mode: MODES.includes(raw) ? raw : 'off',
    model: (env.MESSAGE_READER_MODEL ?? '').trim() || MESSAGE_READER_DEFAULT_MODEL,
    packetMs: int(env.MESSAGE_READER_PACKET_MS, 3_000, 100, 60_000),
    timeoutMs: int(env.MESSAGE_READER_TIMEOUT_MS, 25_000, 1_000, 600_000),
    maxAgeMin: int(env.MESSAGE_READER_MAX_AGE_MIN, 30, 1, 24 * 60),
    retryMaxAgeMin: 5,
  };
}
