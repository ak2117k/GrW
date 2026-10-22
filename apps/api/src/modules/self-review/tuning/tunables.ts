/**
 * The self-review ALLOW-LIST (docs/superpowers/plans/2026-10-21-self-review-contract.md, "Proposals").
 *
 * The only knobs the self-review loop may ever propose, apply or serve. Each has a code default and
 * hard bounds; anything not listed here is rejected at proposal creation, at approval, AND when an
 * override is read back (a hand-written `tuning_overrides` row for an unknown target is ignored).
 *
 * NEVER add a target that touches max daily loss, max position size, the kill switch, the hold
 * switch, the daily exit cap, auto-exit enable/mode, the broker or credentials. {@link isForbiddenTarget}
 * is a second, name-based tripwire for exactly that, checked even for listed targets.
 */

export const SCORECARD_WEIGHT_FACTORS = ['oi', 'fii_dii', 'vix', 'expiry', 'news', 'indicators', 'mood'] as const;
export type WeightFactor = (typeof SCORECARD_WEIGHT_FACTORS)[number];

export type TunableValue = number | boolean;

export interface NumberTunable {
  kind: 'number';
  /** The code default; `null` = the consumer's own (env-derived) value is the default. */
  default: number | null;
  min: number;
  max: number;
  integer: boolean;
}
export interface BooleanTunable {
  kind: 'boolean';
  default: boolean;
}
export type Tunable = NumberTunable | BooleanTunable;

export const weightTarget = (f: WeightFactor): string => `scorecard.factor.${f}.weight`;
export const NEWS_CONFIRMATION_TARGET = 'scorecard.factor.news.requireConfirmation';
export const OPENING_GUARD_TARGET = 'exit.openingGuardMin';
export const PERSIST_MIN_TARGET = 'exit.persistMinSec';
/**
 * Stock big-move model points in the expected-move (mood) factor (2026-10-22 stock-move contract):
 * 0 = shadow (shown, never counted); 1 = a long option +1 on TOP20, −1 on BOTTOM20. Never direction.
 */
export const STOCK_MOVE_POINTS_TARGET = 'scorecard.stockMove.points';
/**
 * The MBM move-size model as an input to the sentinel's packet (read by the sentinel, default false).
 * Rule-only: proposed from the run summary's rolling-20 skill verdict (EDGE twice → on, NO_EDGE twice → off).
 */
export const MBM_PACKET_TARGET = 'mbm.packet';

/** Exit defaults are the env-parsed config (15 / 120 when unset); the bounds are tighter than env's. */
export const EXIT_OPENING_GUARD_DEFAULT = 15;
export const EXIT_PERSIST_MIN_DEFAULT = 120;

export const TUNABLES: Readonly<Record<string, Tunable>> = Object.freeze({
  ...Object.fromEntries(
    SCORECARD_WEIGHT_FACTORS.map((f) => [weightTarget(f), { kind: 'number', default: 1.0, min: 0, max: 1.5, integer: false } as Tunable]),
  ),
  [NEWS_CONFIRMATION_TARGET]: { kind: 'boolean', default: false },
  [OPENING_GUARD_TARGET]: { kind: 'number', default: EXIT_OPENING_GUARD_DEFAULT, min: 0, max: 30, integer: true },
  [PERSIST_MIN_TARGET]: { kind: 'number', default: EXIT_PERSIST_MIN_DEFAULT, min: 60, max: 600, integer: true },
  [STOCK_MOVE_POINTS_TARGET]: { kind: 'number', default: 0, min: 0, max: 1, integer: true },
  [MBM_PACKET_TARGET]: { kind: 'boolean', default: false },
});

/** Words no self-modifiable target may contain, whatever the allow-list says. */
const FORBIDDEN = /(daily.?loss|max.?loss|position.?size|kill|hold.?switch|\bhold\b|exit.?cap|cap$|auto.?exit|autoexit|enable|mode|broker|credential|secret|password|api.?key|risk)/i;

export function isForbiddenTarget(target: string): boolean {
  return FORBIDDEN.test(target);
}

export function isAllowedTarget(target: string): boolean {
  return Object.prototype.hasOwnProperty.call(TUNABLES, target) && !isForbiddenTarget(target);
}

export type ValidateResult = { ok: true; value: TunableValue } | { ok: false; reason: string };

/** Type- and bounds-check a value for `target`. Never clamps: an out-of-range value is rejected. */
export function validateTunable(target: string, value: unknown): ValidateResult {
  if (!isAllowedTarget(target)) return { ok: false, reason: `target ${target} is not allow-listed` };
  const t = TUNABLES[target];
  if (t.kind === 'boolean') {
    return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: `${target} needs a boolean` };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: `${target} needs a finite number` };
  if (t.integer && !Number.isInteger(value)) return { ok: false, reason: `${target} needs an integer` };
  if (value < t.min || value > t.max) return { ok: false, reason: `${target}=${value} is outside ${t.min}–${t.max}` };
  return { ok: true, value };
}

/** Clamp a number into `target`'s bounds (rounded when integer). For the proposal engine's arithmetic. */
export function clampTunable(target: string, value: number): number {
  const t = TUNABLES[target];
  if (!t || t.kind !== 'number') return value;
  const v = Math.min(t.max, Math.max(t.min, value));
  return t.integer ? Math.round(v) : Math.round(v * 1000) / 1000;
}

/** The read side every consumer codes against: `get(target, default)`, synchronous, never throws. */
export interface TuningReader {
  get<T extends TunableValue>(target: string, fallback: T): T;
}

/** The DI token consumers inject (`@Optional()`): absent ⇒ every value is the consumer's default. */
export const TUNING_READER = Symbol('TUNING_READER');

/** A reader that always answers the default (tests, and modules booted without self-review). */
export const DEFAULT_TUNING: TuningReader = { get: (_target, fallback) => fallback };
