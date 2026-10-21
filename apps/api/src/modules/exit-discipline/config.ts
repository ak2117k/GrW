/**
 * Exit discipline (docs/superpowers/specs/2026-10-14-exit-discipline-design.md §10).
 * One pure parse shared by trade-sentinel and sentinel-executor. A typo never
 * widens AI selling: unknown/out-of-range values fall back to the default and
 * are reported; the master switch is OFF only for the exact word `false`.
 */
export const EXIT_DISCIPLINE_CONFIG = 'EXIT_DISCIPLINE_CONFIG';

export const EXIT_DISCIPLINE_DEFAULTS = {
  floorArmN: 1.5,
  floorTrailN: 2.0,
  givebackN: 1.5,
  gateCloseMin: 10,
  gateUnderlyingN: 1.0,
  persistWindowSec: 300,
  persistMinSec: 120,
  outcomeWindowMin: 60,
  openingGuardMin: 15,
} as const;

/** Spec text, not tunables. */
export const EXPIRY_CLOSE_MIN = 30;
export const CLEAR_MARGIN_N = 0.5;
export const INVALIDATION_SCALE_TOLERANCE = 0.2;
export const STREAK_LOOKBACK_MIN = 60;
export const NOISE_LOOKBACK_MIN = 120;
export const ATR_PERIOD = 14;
export const EXIT_CONFIRM_MAX_RELOOKS = 3;
export const GATE_LOAD_TIMEOUT_MS = 2000;

export interface ExitDisciplineConfig {
  enabled: boolean;
  floorArmN: number;
  floorTrailN: number;
  givebackN: number;
  gateCloseMin: number;
  gateUnderlyingN: number;
  persistWindowSec: number;
  persistMinSec: number;
  outcomeWindowMin: number;
  /** Minutes after the session open in which only HARD_RISK may sell (the opening spike is noise). */
  openingGuardMin: number;
  problems: string[];
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number, ok: (n: number) => boolean, problems: string[]): number {
  const raw = env[key];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  problems.push(`${key}=${raw} is out of range — using ${fallback}`);
  return fallback;
}
const int = (lo: number, hi: number) => (n: number) => Number.isInteger(n) && n >= lo && n <= hi;
const real = (lo: number, hi: number) => (n: number) => n >= lo && n <= hi;

export function parseExitDisciplineConfig(env: Env): ExitDisciplineConfig {
  const problems: string[] = [];
  const raw = (env.EXIT_DISCIPLINE_ENABLED ?? '').trim();
  if (raw !== '' && raw !== 'true' && raw !== 'false') {
    problems.push(`EXIT_DISCIPLINE_ENABLED=${raw} is not true|false — keeping exit discipline ON`);
  }
  const d = EXIT_DISCIPLINE_DEFAULTS;
  return {
    enabled: raw !== 'false',
    floorArmN: num(env, 'FLOOR_ARM_N', d.floorArmN, real(0.5, 5), problems),
    floorTrailN: num(env, 'FLOOR_TRAIL_N', d.floorTrailN, real(0.5, 6), problems),
    givebackN: num(env, 'GIVEBACK_N', d.givebackN, real(0.5, 6), problems),
    gateCloseMin: num(env, 'GATE_CLOSE_MIN', d.gateCloseMin, int(0, 60), problems),
    gateUnderlyingN: num(env, 'GATE_UNDERLYING_N', d.gateUnderlyingN, real(0.25, 4), problems),
    persistWindowSec: num(env, 'PERSIST_WINDOW_SEC', d.persistWindowSec, int(30, 1800), problems),
    persistMinSec: num(env, 'PERSIST_MIN_SEC', d.persistMinSec, int(0, 900), problems),
    outcomeWindowMin: num(env, 'EXIT_OUTCOME_WINDOW_MIN', d.outcomeWindowMin, int(15, 240), problems),
    openingGuardMin: num(env, 'EXIT_OPENING_GUARD_MIN', d.openingGuardMin, int(0, 60), problems),
    problems,
  };
}

export function describeExitDiscipline(c: ExitDisciplineConfig): string {
  return `${c.enabled ? 'ON' : 'OFF'} floorArmN=${c.floorArmN} floorTrailN=${c.floorTrailN} givebackN=${c.givebackN} ` +
    `gateCloseMin=${c.gateCloseMin} gateUnderlyingN=${c.gateUnderlyingN} ` +
    `persist=${c.persistWindowSec}s/${c.persistMinSec}s openingGuard=${c.openingGuardMin}m outcomeWindow=${c.outcomeWindowMin}m`;
}
