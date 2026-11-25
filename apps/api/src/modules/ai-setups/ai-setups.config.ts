/** AI setups settings. Env-only; every knob has a safe default (setups are off unless switched to paper). */
export type AiSetupsMode = 'off' | 'paper';

export interface AiSetupsConfig {
  /** AI_SETUPS — off (default) | paper. There is no live mode in this plan: `live` and anything unknown = off. */
  mode: AiSetupsMode;
  /** AI_SETUP_MODEL — the setup model (Opus, effort high). */
  model: string;
  /** AI_SETUP_PACKET_MS — time box for building the setup packet. */
  packetMs: number;
  /** AI setups per IST day (paper and live alike). Fixed. */
  maxPerDay: 3;
  /** Minutes after a setup before the same underlying may get another. Fixed. */
  cooldownMin: 30;
  /** AI_SETUP_MIN_OI — minimum open interest (contracts) of the named option strike. */
  minOi: number;
}

export const AI_SETUPS_CONFIG = Symbol('AI_SETUPS_CONFIG');
export const AI_SETUP_DEFAULT_MODEL = 'claude-opus-5';

const MODES: readonly AiSetupsMode[] = ['off', 'paper'];

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

export function parseAiSetupsConfig(env: Record<string, string | undefined>): AiSetupsConfig {
  const raw = String(env.AI_SETUPS ?? '').trim().toLowerCase() as AiSetupsMode;
  return {
    mode: MODES.includes(raw) ? raw : 'off',
    model: (env.AI_SETUP_MODEL ?? '').trim() || AI_SETUP_DEFAULT_MODEL,
    packetMs: int(env.AI_SETUP_PACKET_MS, 8_000, 500, 60_000),
    maxPerDay: 3,
    cooldownMin: 30,
    minOi: int(env.AI_SETUP_MIN_OI, 500, 0, 100_000_000),
  };
}
