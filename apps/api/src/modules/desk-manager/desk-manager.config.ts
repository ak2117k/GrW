import { parseCeilingByClass } from '../../common/utils/loss-limit';
import type { DeskMode } from './domain/desk.types';

/** Desk manager settings. Env-only, parsed once; every knob has a safe default and the mode defaults to off. */
export interface DeskManagerConfig {
  /** DESK_MANAGER — off (default) | shadow | live. */
  mode: DeskMode;
  /** HUB_OWNER_USER_ID — the one desk (owner account only). */
  ownerUserId: string | null;
  /** DESK_MANAGER_MODEL. */
  model: string;
  /** DESK_MANAGER_MAX_ENTRIES — manager OPENs per IST day. */
  maxEntries: number;
  /** DESK_MANAGER_MAX_EXITS — manager EXIT/BOOK per IST day. */
  maxExits: number;
  /** DESK_MANAGER_MAX_CALLS — manager AI calls per IST day. */
  maxCalls: number;
  busyEveryMin: 3;
  idleEveryMin: 10;
  debounceMs: 20000;
  runTimeoutMs: 150000;
  noEntryLastMin: 30;
  minRewardRisk: 1.2;
  guard: { drawdownRupees: number; dayLossRupees: number; lossStreak: number };
  /** Per-trade max loss by instrument class (HARD_LOSS_CEILING_BY_CLASS over the owner-decided defaults). */
  ceilings: Record<string, number>;
}

export const DESK_MANAGER_CONFIG = Symbol('DESK_MANAGER_CONFIG');
export const DESK_MANAGER_DEFAULT_MODEL = 'claude-opus-5-5';

/** Owner 2026-11-25/26: INDEX_OPT 5000, STOCK_OPT 3000, GOLD/SILVER 7500, minis 4000, other MCX 5000. */
export const DEFAULT_CEILINGS: Readonly<Record<string, number>> = Object.freeze({
  INDEX_OPT: 5000,
  STOCK_OPT: 3000,
  GOLD: 7500,
  SILVER: 7500,
  GOLD_MINI: 4000,
  SILVER_MINI: 4000,
  MCX: 5000,
});

const MODES: readonly DeskMode[] = ['off', 'shadow', 'live'];

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

export function parseDeskManagerConfig(env: Record<string, string | undefined>): DeskManagerConfig {
  const raw = String(env.DESK_MANAGER ?? '').trim().toLowerCase() as DeskMode;
  const owner = String(env.HUB_OWNER_USER_ID ?? '').trim();
  const fromEnv = parseCeilingByClass(env.HARD_LOSS_CEILING_BY_CLASS) as Record<string, number | undefined>;
  const ceilings: Record<string, number> = { ...DEFAULT_CEILINGS };
  for (const [k, v] of Object.entries(fromEnv)) if (typeof v === 'number' && Number.isFinite(v) && v > 0) ceilings[k] = v;
  return {
    mode: MODES.includes(raw) ? raw : 'off',
    ownerUserId: owner || null,
    model: (env.DESK_MANAGER_MODEL ?? '').trim() || DESK_MANAGER_DEFAULT_MODEL,
    maxEntries: int(env.DESK_MANAGER_MAX_ENTRIES, 5, 0, 20),
    maxExits: int(env.DESK_MANAGER_MAX_EXITS, 20, 0, 100),
    maxCalls: int(env.DESK_MANAGER_MAX_CALLS, 400, 0, 2000),
    busyEveryMin: 3,
    idleEveryMin: 10,
    debounceMs: 20000,
    runTimeoutMs: 150000,
    noEntryLastMin: 30,
    minRewardRisk: 1.2,
    guard: {
      drawdownRupees: int(env.DESK_GUARD_DRAWDOWN_RUPEES, 5000, 0, 10_000_000),
      dayLossRupees: int(env.DESK_GUARD_DAY_LOSS_RUPEES, 8000, 0, 10_000_000),
      lossStreak: int(env.DESK_GUARD_LOSS_STREAK, 3, 1, 20),
    },
    ceilings,
  };
}
