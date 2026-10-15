// apps/api/src/modules/sentinel-executor/domain/confirmation.ts
import type { TriggerOp } from './trigger.types';

export interface ConfirmState {
  count: number;
  firstAt: number | null;
  lastAt: number | null;
}

export const EMPTY_CONFIRM: ConfirmState = Object.freeze({ count: 0, firstAt: null, lastAt: null }) as ConfirmState;

/**
 * Ruling R6 / spec §3.4 D2. Fire once the level has been crossed on `ticks`
 * consecutive accepted ticks AND for at least `ms` (first beyond-tick → this one).
 * A not-beyond tick, a gap longer than `gapResetMs`, or an out-of-order tick
 * restarts the count. Strict inequality: touching the level is not crossing it.
 * Pure and allocation-light: it runs on every tick of a watched instrument.
 */
export function stepConfirm(
  s: ConfirmState,
  tick: { price: number; at: number },
  level: { op: TriggerOp; price: number },
  cfg: { ticks: number; ms: number; gapResetMs: number },
): { state: ConfirmState; fire: boolean } {
  const beyond = level.op === 'BELOW' ? tick.price < level.price : tick.price > level.price;
  if (!beyond) return { state: EMPTY_CONFIRM, fire: false };
  const continuous = s.lastAt !== null && tick.at >= s.lastAt && tick.at - s.lastAt <= cfg.gapResetMs;
  const count = (continuous ? s.count : 0) + 1;
  const firstAt = continuous && s.firstAt !== null ? s.firstAt : tick.at;
  const state: ConfirmState = { count, firstAt, lastAt: tick.at };
  return { state, fire: count >= cfg.ticks && tick.at - firstAt >= cfg.ms };
}
