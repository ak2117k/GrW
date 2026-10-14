// apps/api/src/modules/sentinel-executor/domain/auto-exit.config.ts
import {
  AUTO_EXIT_EXCHANGES,
  DEFAULT_QTY_UNITS,
  type AutoExitConfig,
  type AutoExitMode,
  type QtyUnit,
} from './auto-exit.types';

const DEFAULTS = { dailyCap: 5, maxVerdictAgeSec: 90, limitFallbackPct: 2 } as const;

function num(
  raw: string | undefined,
  name: string,
  fallback: number,
  ok: (n: number) => boolean,
  problems: string[],
): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  problems.push(`${name}=${raw} is out of range — using ${fallback}`);
  return fallback;
}

/**
 * AI_AUTO_EXIT_QTY_UNITS (plan ruling R16): `EXCHANGE:units|lots`, comma separated,
 * merged over DEFAULT_QTY_UNITS. Fails CLOSED: a malformed or contradictory entry
 * for an in-scope exchange removes that exchange's unit, so it cannot go live.
 */
function parseQtyUnits(raw: string | undefined, problems: string[]): Partial<Record<string, QtyUnit>> {
  const out: Partial<Record<string, QtyUnit>> = { ...DEFAULT_QTY_UNITS };
  const explicit = new Map<string, QtyUnit | null>();
  for (const entry of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [exPart, unitPart, ...rest] = entry.split(':');
    const ex = String(exPart ?? '').trim().toUpperCase();
    const unit = String(unitPart ?? '').trim().toLowerCase();
    if (!AUTO_EXIT_EXCHANGES.includes(ex)) {
      problems.push(`AI_AUTO_EXIT_QTY_UNITS entry ${entry} names an exchange outside ${AUTO_EXIT_EXCHANGES.join('/')} — ignored`);
      continue;
    }
    if (rest.length > 0 || (unit !== 'units' && unit !== 'lots')) {
      problems.push(`AI_AUTO_EXIT_QTY_UNITS entry ${entry} is not ${ex}:units|lots — ${ex} unit left unconfigured`);
      explicit.set(ex, null);
      continue;
    }
    const prev = explicit.get(ex);
    if (prev === null) continue; // already poisoned
    if (prev !== undefined && prev !== unit) {
      problems.push(`AI_AUTO_EXIT_QTY_UNITS gives ${ex} two units — ${ex} unit left unconfigured`);
      explicit.set(ex, null);
      continue;
    }
    explicit.set(ex, unit);
  }
  for (const [ex, unit] of explicit) {
    if (unit === null) delete out[ex];
    else out[ex] = unit;
  }
  return out;
}

/**
 * Pure parse of the AI_AUTO_EXIT_* env (spec §7). Every unknown or out-of-range
 * value falls back to the SAFE default and is reported in `problems`, never thrown:
 * a typo must not stop the API from booting, and must not widen what the executor does.
 */
export function parseAutoExitConfig(env: Record<string, string | undefined>): AutoExitConfig {
  const problems: string[] = [];

  const rawMode = (env.AI_AUTO_EXIT_MODE ?? '').trim();
  let mode: AutoExitMode = 'dry-run';
  if (rawMode === 'live') mode = 'live';
  else if (rawMode !== '' && rawMode !== 'dry-run') {
    problems.push(`AI_AUTO_EXIT_MODE=${rawMode} is not dry-run|live — using dry-run`);
  }

  const userIds = [
    ...new Set(
      String(env.AI_AUTO_EXIT_USER_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];

  return {
    enabled: env.AI_AUTO_EXIT_ENABLED === 'true',
    mode,
    userIds,
    dailyCap: num(env.AI_AUTO_EXIT_DAILY_CAP, 'AI_AUTO_EXIT_DAILY_CAP', DEFAULTS.dailyCap,
      (n) => Number.isInteger(n) && n >= 0 && n <= 50, problems),
    maxVerdictAgeSec: num(env.AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC, 'AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC',
      DEFAULTS.maxVerdictAgeSec, (n) => Number.isInteger(n) && n >= 10 && n <= 600, problems),
    limitFallbackPct: num(env.AI_AUTO_EXIT_LIMIT_FALLBACK_PCT, 'AI_AUTO_EXIT_LIMIT_FALLBACK_PCT',
      DEFAULTS.limitFallbackPct, (n) => n >= 0.5 && n <= 10, problems),
    qtyUnits: parseQtyUnits(env.AI_AUTO_EXIT_QTY_UNITS, problems),
    cancelProtective: env.AI_AUTO_EXIT_CANCEL_PROTECTIVE === 'true',
    problems,
  };
}
