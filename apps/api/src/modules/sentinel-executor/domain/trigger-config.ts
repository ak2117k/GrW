// apps/api/src/modules/sentinel-executor/domain/trigger-config.ts
import type { TriggerInstrument } from './trigger.types';

export interface TriggerConfig {
  enabled: boolean;
  confirmTicks: number;
  confirmMs: number;
  maxAgeMin: number;
  maxDistancePct: Record<TriggerInstrument, number>;
  tightenOnly: boolean;
  problems: string[];
}

const DEFAULTS = { confirmTicks: 2, confirmMs: 1000, maxAgeMin: 240 } as const;
const DISTANCE_DEFAULTS: Record<TriggerInstrument, number> = { UNDERLYING: 10, PREMIUM: 60 };
const DISTANCE_MAX: Record<TriggerInstrument, number> = { UNDERLYING: 25, PREMIUM: 90 };

function num(raw: string | undefined, name: string, fallback: number, ok: (n: number) => boolean, problems: string[]): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  problems.push(`${name}=${raw} is out of range — using ${fallback}`);
  return fallback;
}

function distances(raw: string | undefined, problems: string[]): Record<TriggerInstrument, number> {
  const out = { ...DISTANCE_DEFAULTS };
  for (const entry of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v, ...rest] = entry.split(':');
    const key = String(k ?? '').trim().toUpperCase();
    if (key !== 'UNDERLYING' && key !== 'PREMIUM') {
      problems.push(`SENTINEL_TRIGGER_MAX_DISTANCE_PCT entry ${entry} names ${key || 'nothing'}, not UNDERLYING|PREMIUM — ignored`);
      continue;
    }
    const n = Number(v);
    if (rest.length > 0 || v === undefined || !Number.isFinite(n) || n <= 0 || n > DISTANCE_MAX[key]) {
      problems.push(`SENTINEL_TRIGGER_MAX_DISTANCE_PCT entry ${entry} is not ${key}:(0,${DISTANCE_MAX[key]}] — ${key} stays ${DISTANCE_DEFAULTS[key]}`);
      continue;
    }
    out[key] = n;
  }
  return out;
}

/**
 * Pure parse of SENTINEL_TRIGGER* (spec §5). Never throws; a bad value falls back
 * to the default and is reported, so a typo can neither stop boot nor widen what
 * a trigger may do.
 */
export function parseTriggerConfig(env: Record<string, string | undefined>): TriggerConfig {
  const problems: string[] = [];
  return {
    enabled: env.SENTINEL_TRIGGERS_ENABLED === 'true',
    confirmTicks: num(env.SENTINEL_TRIGGER_CONFIRM_TICKS, 'SENTINEL_TRIGGER_CONFIRM_TICKS', DEFAULTS.confirmTicks,
      (n) => Number.isInteger(n) && n >= 1 && n <= 10, problems),
    confirmMs: num(env.SENTINEL_TRIGGER_CONFIRM_MS, 'SENTINEL_TRIGGER_CONFIRM_MS', DEFAULTS.confirmMs,
      (n) => Number.isInteger(n) && n >= 0 && n <= 10_000, problems),
    maxAgeMin: num(env.SENTINEL_TRIGGER_MAX_AGE_MIN, 'SENTINEL_TRIGGER_MAX_AGE_MIN', DEFAULTS.maxAgeMin,
      (n) => Number.isInteger(n) && n >= 5 && n <= 1440, problems),
    maxDistancePct: distances(env.SENTINEL_TRIGGER_MAX_DISTANCE_PCT, problems),
    tightenOnly: env.SENTINEL_TRIGGER_TIGHTEN_ONLY !== 'false',
    problems,
  };
}
