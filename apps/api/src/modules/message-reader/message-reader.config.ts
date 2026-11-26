/** AI message reader settings. Env-only; every knob has a safe default (the reader is off unless switched on). */
export type ReaderMode = 'off' | 'shadow' | 'on';

export interface MessageReaderConfig {
  /** MESSAGE_READER — off (default) | shadow (read + store, judge blind) | on (judge sees readings). Unknown = off. */
  mode: ReaderMode;
  /** MESSAGE_READER_MODEL — the reading model. */
  model: string;
  /** MESSAGE_READER_PACKET_MS — time box for building the market-data packet. */
  packetMs: number;
  /**
   * MESSAGE_READER_BREADTH_MS — the breadth (advance / decline) block's own time box (default 6000), separate
   * from packetMs: breadth reads a whole quote batch and a timed-out breadth leaves MARKET claims uncheckable.
   */
  breadthMs: number;
  /** MESSAGE_READER_TIMEOUT_MS — the AI call timeout. */
  timeoutMs: number;
  /** MESSAGE_READER_MAX_AGE_MIN — posts older than this at dequeue are stored STALE, not read. */
  maxAgeMin: number;
  /** One retry is allowed only while the post is younger than this (minutes). Fixed. */
  retryMaxAgeMin: 5;
  /** MESSAGE_READER_MAX_IN_FLIGHT — reads in flight at once in this process (default 8). */
  maxInFlight: number;
  /**
   * MESSAGE_READER_MAX_INSTRUMENT_BUILDS — reader instrument-context builds (owner's broker session) in
   * flight at once across all posts (default 2). Extra underlyings wait, or are marked unavailable
   * "reader build limit" once the packet deadline passes.
   */
  maxInstrumentBuilds: number;
  /** MESSAGE_READER_SKIP_STRUCTURE — skip the structure / level-book block in reader builds (default true). */
  skipStructure: boolean;
  /** AGENTS_GLOBAL_CONCURRENCY as this process sees it (default 16) — only for the boot warning. */
  agentsGlobalConcurrency: number;
}

export const MESSAGE_READER_CONFIG = Symbol('MESSAGE_READER_CONFIG');
export const MESSAGE_READER_DEFAULT_MODEL = 'claude-sonnet-5';
/** Below this project-wide Vertex cap the reader's low-tier share is thin; warned once at boot. */
export const READER_MIN_GLOBAL_CONCURRENCY = 24;

const MODES: readonly ReaderMode[] = ['off', 'shadow', 'on'];

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

const bool = (v: string | undefined, d: boolean) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return d;
};

export function parseMessageReaderConfig(env: Record<string, string | undefined>): MessageReaderConfig {
  const raw = String(env.MESSAGE_READER ?? '').trim().toLowerCase() as ReaderMode;
  return {
    mode: MODES.includes(raw) ? raw : 'off',
    model: (env.MESSAGE_READER_MODEL ?? '').trim() || MESSAGE_READER_DEFAULT_MODEL,
    packetMs: int(env.MESSAGE_READER_PACKET_MS, 3_000, 100, 60_000),
    breadthMs: int(env.MESSAGE_READER_BREADTH_MS, 6_000, 100, 60_000),
    timeoutMs: int(env.MESSAGE_READER_TIMEOUT_MS, 25_000, 1_000, 600_000),
    maxAgeMin: int(env.MESSAGE_READER_MAX_AGE_MIN, 30, 1, 24 * 60),
    retryMaxAgeMin: 5,
    maxInFlight: int(env.MESSAGE_READER_MAX_IN_FLIGHT, 8, 1, 64),
    maxInstrumentBuilds: int(env.MESSAGE_READER_MAX_INSTRUMENT_BUILDS, 2, 1, 16),
    skipStructure: bool(env.MESSAGE_READER_SKIP_STRUCTURE, true),
    agentsGlobalConcurrency: int(env.AGENTS_GLOBAL_CONCURRENCY, 16, 0, 10_000),
  };
}

/** The boot warning for a reader that is on with a thin project-wide AI cap, or null. */
export function readerConcurrencyWarning(cfg: Pick<MessageReaderConfig, 'mode' | 'agentsGlobalConcurrency'>): string | null {
  if (cfg.mode === 'off' || cfg.agentsGlobalConcurrency >= READER_MIN_GLOBAL_CONCURRENCY) return null;
  return (
    `message-reader: MESSAGE_READER=${cfg.mode} with AGENTS_GLOBAL_CONCURRENCY=${cfg.agentsGlobalConcurrency} (< ${READER_MIN_GLOBAL_CONCURRENCY}). ` +
    `signal.read only uses non-trading slots while 4 stay free for live parse / vision calls, so reads will queue and may time out. ` +
    `Raise AGENTS_GLOBAL_CONCURRENCY to ${READER_MIN_GLOBAL_CONCURRENCY}+ for the reader.`
  );
}
