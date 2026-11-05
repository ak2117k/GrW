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
  floorHardExitN: 2.0,
  floorNoiseConfirmN: 1.0,
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
/**
 * Hard floor exit (hard-floor.ts): the trip must hold on two consecutive cycle reads at least this
 * many seconds apart — one 30-s cycle step — so a single print through the floor never sells.
 */
export const FLOOR_HARD_CONFIRM_SEC = 20;
/** Hard floor exit: after a rule EXIT_NOW is recorded, the rule stays quiet this long while the exit runs. */
export const FLOOR_HARD_REFIRE_SEC = 120;
/**
 * SPIKE BANK (spike.ts, owner-approved 2026-11-04): a new best premium reached by a jump of at least
 * SPIKE_BANK_RISE_N contract noise units (the floor's own N) above the lowest premium of the previous
 * SPIKE_BANK_WINDOW_MIN minutes latches the position's trail from floorTrailN to SPIKE_BANK_TRAIL_N.
 * Prod 2026-11-04 NIFTY 23650 PE: 141.7 → 155.6 in three minutes, the 2 N trail sat 12 points under
 * the spike, and the snap-back sold the trade red.
 */
export const SPIKE_BANK_RISE_N = 2.5;
export const SPIKE_BANK_WINDOW_MIN = 3;
export const SPIKE_BANK_TRAIL_N = 1.0;

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
  /**
   * FLOOR_HARD_EXIT (ON unless exactly `false`; prod 2026-10-29 CRUDEOILM 9350 PE): adverse moves are
   * measured from FIXED references — the position's best point and the floor's arm point — never from
   * the last verdict, and an armed green floor is a deterministic exit (hard-floor.ts) rather than a
   * level the judge may keep re-anchoring. Off: packet, prompt, gate and cycle are exactly as before.
   */
  floorHardExit: boolean;
  /** FLOOR_HARD_EXIT_N (default 2, 1–6): K — the underlying's move against the position, in its own noise units, from the best point. */
  floorHardExitN: number;
  /**
   * FLOOR_LOCK_GREEN (ON unless exactly `false`; owner-approved 2026-11-04): an armed floor broken while
   * the position is still net green is a hard-floor exit (FLOOR_BREAK_GREEN) — no K·N underlying move
   * required. Off: only GREEN_TO_RED / HWM_UNDERLYING_MOVE, exactly as before. Acts only with floorHardExit.
   */
  floorLockGreen: boolean;
  /**
   * FLOOR_NOISE_CONFIRM_N (default 1, 0 = off, 0–3; owner 2026-11-05 "identify the noise and decide").
   * A broken floor is an exit by GREEN_TO_RED / FLOOR_BREAK_GREEN only when the UNDERLYING has moved at least
   * this many of its own noise units against the position from its best point; less than that is the contract's
   * own noise and the position is held. Prod 2026-11-05 SUZLON 40 CE (0.81 → 0.85 → 0.82, Suzlon 38.55 → 38.54):
   * sold on a 3-tick wobble while the stock moved one paisa. An unmeasurable underlying keeps the price-only
   * rule (fail safe). HWM_UNDERLYING_MOVE (K·N) and MAX_LOSS are untouched.
   */
  floorNoiseConfirmN: number;
  /**
   * FLOOR_SPIKE_BANK (ON unless exactly `false`; owner-approved 2026-11-04): a fast new best latches the
   * tighter SPIKE_BANK_TRAIL_N trail (spike.ts). Off: the trail is floorTrailN, as before. Acts only with floorHardExit.
   */
  spikeBank: boolean;
  /**
   * The spike bank's rise / trail in contract N (2026-11-05: self-review tunables exit.spikeBankRiseN /
   * exit.spikeBankTrailN). Absent ⇒ SPIKE_BANK_RISE_N / SPIKE_BANK_TRAIL_N, exactly as before.
   */
  spikeBankRiseN?: number;
  spikeBankTrailN?: number;
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
  // A typo keeps the hard floor ON: it only sells a position whose armed floor has broken AND that
  // has turned red (or whose underlying ran K·N against it), and the executor's guards still apply.
  const hard = (env.FLOOR_HARD_EXIT ?? '').trim();
  if (hard !== '' && hard !== 'true' && hard !== 'false') {
    problems.push(`FLOOR_HARD_EXIT=${hard} is not true|false — keeping the hard floor exit ON`);
  }
  const lock = (env.FLOOR_LOCK_GREEN ?? '').trim();
  if (lock !== '' && lock !== 'true' && lock !== 'false') {
    problems.push(`FLOOR_LOCK_GREEN=${lock} is not true|false — keeping the green-lock floor exit ON`);
  }
  const spike = (env.FLOOR_SPIKE_BANK ?? '').trim();
  if (spike !== '' && spike !== 'true' && spike !== 'false') {
    problems.push(`FLOOR_SPIKE_BANK=${spike} is not true|false — keeping the spike bank ON`);
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
    floorHardExit: hard !== 'false',
    floorHardExitN: num(env, 'FLOOR_HARD_EXIT_N', d.floorHardExitN, real(1, 6), problems),
    floorLockGreen: lock !== 'false',
    floorNoiseConfirmN: num(env, 'FLOOR_NOISE_CONFIRM_N', d.floorNoiseConfirmN, real(0, 3), problems),
    spikeBank: spike !== 'false',
    problems,
  };
}

export function describeExitDiscipline(c: ExitDisciplineConfig): string {
  return `${c.enabled ? 'ON' : 'OFF'} floorArmN=${c.floorArmN} floorTrailN=${c.floorTrailN} givebackN=${c.givebackN} ` +
    `gateCloseMin=${c.gateCloseMin} gateUnderlyingN=${c.gateUnderlyingN} ` +
    `persist=${c.persistWindowSec}s/${c.persistMinSec}s openingGuard=${c.openingGuardMin}m outcomeWindow=${c.outcomeWindowMin}m ` +
    `floorHardExit=${c.floorHardExit ? `ON K=${c.floorHardExitN}` : 'off'} ` +
    `lockGreen=${c.floorLockGreen ? 'ON' : 'off'} ` +
    `spikeBank=${c.spikeBank ? `ON ${SPIKE_BANK_RISE_N}N/${SPIKE_BANK_WINDOW_MIN}m→trail ${SPIKE_BANK_TRAIL_N}N` : 'off'}`;
}

/**
 * Self-review overrides (docs/superpowers/plans/2026-10-21-self-review-contract.md): an approved
 * `exit.openingGuardMin` (0–30) / `exit.persistMinSec` (60–600) wins over the env value. Bounded
 * again here: an out-of-range or non-integer answer keeps the env value. Nothing else is tunable.
 */
export function withExitTuning(cfg: ExitDisciplineConfig, tuning: { get<T extends number | boolean>(target: string, fallback: T): T } | null | undefined): ExitDisciplineConfig {
  if (!tuning) return cfg;
  const bounded = (target: string, current: number, lo: number, hi: number): number => {
    let v: number;
    try {
      v = tuning.get(target, current);
    } catch {
      return current;
    }
    return Number.isInteger(v) && v >= lo && v <= hi ? v : current;
  };
  const openingGuardMin = bounded('exit.openingGuardMin', cfg.openingGuardMin, 0, 30);
  const persistMinSec = bounded('exit.persistMinSec', cfg.persistMinSec, 60, 600);
  return openingGuardMin === cfg.openingGuardMin && persistMinSec === cfg.persistMinSec ? cfg : { ...cfg, openingGuardMin, persistMinSec };
}

/** The reader shape of the self-review tunables (self-review/tuning/tunables.ts TuningReader). */
export type ExitTuningReader = { get<T extends number | boolean>(target: string, fallback: T): T };

/** Bounds the loop may set (self-review/tuning/tunables.ts), checked again here. */
const SESSION_EXIT_BOUNDS = {
  floorArmN: ['exit.floorArmN', 1.0, 3.0],
  floorTrailN: ['exit.floorTrailN', 1.0, 3.5],
  spikeBankRiseN: ['exit.spikeBankRiseN', 1.5, 4.0],
  spikeBankTrailN: ['exit.spikeBankTrailN', 0.5, 2.0],
} as const;

/**
 * 2026-11-05 wrong-decision loop (S7): the floor's arm / trail N and the spike bank's rise / trail N as
 * self-review tunables, read from the SESSION-OPEN reader (values fixed per IST session date). Returns
 * `base` with those four fields as getters, so every holder of the injected EXIT_DISCIPLINE_CONFIG (the
 * sentinel cycle, the tick source, the exit gate, paper exits) reads the session's value with no change of
 * its own. No reader ⇒ `base` itself. No override / an out-of-range or throwing answer ⇒ the env value
 * (FLOOR_ARM_N / FLOOR_TRAIL_N) or SPIKE_BANK_RISE_N / SPIKE_BANK_TRAIL_N — exactly today's behaviour.
 */
export function withSessionExitTuning(base: ExitDisciplineConfig, tuning: ExitTuningReader | null | undefined): ExitDisciplineConfig {
  if (!tuning) return base;
  const fallbacks: Record<keyof typeof SESSION_EXIT_BOUNDS, number> = {
    floorArmN: base.floorArmN,
    floorTrailN: base.floorTrailN,
    spikeBankRiseN: base.spikeBankRiseN ?? SPIKE_BANK_RISE_N,
    spikeBankTrailN: base.spikeBankTrailN ?? SPIKE_BANK_TRAIL_N,
  };
  const out = { ...base } as ExitDisciplineConfig;
  for (const key of Object.keys(SESSION_EXIT_BOUNDS) as Array<keyof typeof SESSION_EXIT_BOUNDS>) {
    const [target, lo, hi] = SESSION_EXIT_BOUNDS[key];
    const fallback = fallbacks[key];
    Object.defineProperty(out, key, {
      enumerable: true,
      get: (): number => {
        let v: number;
        try {
          v = tuning.get(target, fallback);
        } catch {
          return fallback;
        }
        return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
      },
    });
  }
  return out;
}
