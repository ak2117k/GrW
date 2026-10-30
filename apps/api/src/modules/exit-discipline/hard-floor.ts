import { FLOOR_HARD_CONFIRM_SEC, FLOOR_HARD_REFIRE_SEC } from './config';
import type { Exposure, PositionSide } from './types';

/**
 * HARD FLOOR EXIT (owner-approved 2026-10-29: "measure from the best point, and make the floor a
 * hard rule"). Pure.
 *
 * Prod 2026-10-29, CRUDEOILM17NOV269350PE (2 lots, entry 362.55): the premium peaked at 380.4 and
 * the noise floor armed at 376.8, then crude ground up 9539 → 9603 (~5 N) in 22 minutes and netPnl
 * went +180 → −330. 37 verdicts, all HOLD: each measured the adverse move "since my last HOLD", one
 * or two minutes back, so a slow grind of sub-1 N steps never reached one N and the armed floor
 * could never fire. The fix is two fixed references and a rule that does not ask the judge:
 *
 *  - GREEN_TO_RED: an armed floor is broken (premium below it, above it for a short) AND the
 *    position is now net red after charges. The floor never sits below breakeven once armed, so this
 *    is "a trade that was clearly green is now losing money" — the one outcome the floor exists for.
 *  - HWM_UNDERLYING_MOVE: the floor is broken AND the underlying has moved >= K noise units against
 *    the position from where it was at the position's BEST point (FLOOR_HARD_EXIT_N, default 2) —
 *    the trade is still green but the move that made it is clearly undone.
 *
 * A trip sells only once confirmed (`confirmHardFloor`): it must hold on two consecutive cycle reads
 * at least FLOOR_HARD_CONFIRM_SEC apart, so one print through the floor never sells. The exit goes
 * through the same verdict → executor → gate path as an AI EXIT_NOW (owner HOLD, F&O only, the cap).
 */
export type HardFloorRule = 'GREEN_TO_RED' | 'HWM_UNDERLYING_MOVE';

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The underlying's move from `from` to `now` AGAINST the position, in points (+ = against). Null when unknown. */
export function underlyingAgainst(exposure: Exposure | null, from: number | null | undefined, now: number | null | undefined): number | null {
  if (exposure === null || !fin(from) || !fin(now)) return null;
  return r2(exposure === 'BULLISH' ? from - now : now - from);
}

export interface HardFloorInput {
  side: PositionSide;
  /** The direction the underlying must move to help the position (exposureOf). */
  exposure: Exposure | null;
  /** The contract's price now. */
  ltp: number;
  floor: { price: number | null; armed: boolean };
  /** Net P&L after charges now. */
  netPnl: number | null;
  underlying: number | null;
  /** The underlying at the position's best point (FloorAnchors.best.underlying). */
  bestUnderlying: number | null;
  /** The underlying's 1-minute noise unit. */
  nUnderlying: number | null;
  /** FLOOR_HARD_EXIT_N. */
  k: number;
}

export interface HardFloorReading {
  trip: boolean;
  rule: HardFloorRule | null;
  /** The armed floor is broken by ltp. */
  belowFloor: boolean;
  netRed: boolean;
  /** Underlying points against the position from the best point; null when unmeasurable. */
  adverseFromBest: number | null;
  adverseFromBestN: number | null;
}

export function hardFloorReading(i: HardFloorInput): HardFloorReading {
  const fp = i.floor.price;
  const belowFloor = i.floor.armed && fin(fp) && fin(i.ltp) ? (i.side === 'LONG' ? i.ltp < fp : i.ltp > fp) : false;
  const netRed = fin(i.netPnl) && i.netPnl < 0;
  const adverse = underlyingAgainst(i.exposure, i.bestUnderlying, i.underlying);
  const n = fin(i.nUnderlying) && i.nUnderlying > 0 ? i.nUnderlying : null;
  const adverseN = adverse !== null && n !== null ? r2(adverse / n) : null;
  const moved = adverse !== null && n !== null && fin(i.k) && i.k > 0 && adverse >= i.k * n - 1e-9;
  const rule: HardFloorRule | null = !belowFloor ? null : netRed ? 'GREEN_TO_RED' : moved ? 'HWM_UNDERLYING_MOVE' : null;
  return { trip: rule !== null, rule, belowFloor, netRed, adverseFromBest: adverse, adverseFromBestN: adverseN };
}

/** The cycle's per-position confirmation memory (in-process; a restart costs one extra read). */
export interface HardFloorMemo {
  /** Cycle-clock ms of the first read of the current unbroken run of trips; null when not tripped. */
  since: number | null;
  /** Reads in that run. */
  reads: number;
  /** Cycle-clock ms the rule last fired (a rule EXIT_NOW was recorded); null when never. */
  firedAt: number | null;
}
export const EMPTY_HARD_FLOOR_MEMO: HardFloorMemo = { since: null, reads: 0, firedAt: null };

/**
 * Fires on the read that CONFIRMS a trip: tripped on this read and on every read since `since`, at
 * least two reads, the first at least FLOOR_HARD_CONFIRM_SEC ago — and not within FLOOR_HARD_REFIRE_SEC
 * of the last fire (the exit is running; one EXIT_NOW per attempt, not one per pass). Any untripped
 * read resets the run.
 */
export function confirmHardFloor(memo: HardFloorMemo | null | undefined, trip: boolean, nowMs: number): { fire: boolean; memo: HardFloorMemo } {
  const m = memo ?? EMPTY_HARD_FLOOR_MEMO;
  if (!trip) return { fire: false, memo: { since: null, reads: 0, firedAt: m.firedAt } };
  const since = m.since ?? nowMs;
  const reads = m.since === null ? 1 : m.reads + 1;
  const confirmed = reads >= 2 && nowMs - since >= FLOOR_HARD_CONFIRM_SEC * 1000;
  const quiet = m.firedAt === null || nowMs - m.firedAt >= FLOOR_HARD_REFIRE_SEC * 1000;
  const fire = confirmed && quiet;
  return { fire, memo: { since, reads, firedAt: fire ? nowMs : m.firedAt } };
}

/**
 * NO AI STOP INSIDE NOISE (owner-approved 2026-10-30). Pure.
 *
 * Prod 2026-10-30, SENSEX26N0574500CE (paper): the judge set "UNDERLYING BELOW 74459.1" — one noise unit
 * (26.5 pts) under the floor's arm point, as the +a1 gate line then allowed. SENSEX touched 74458.33 for
 * one bar, the trade sold at −₹169, and SENSEX ran to 74634. One N is by definition one ordinary minute's
 * swing. An UNDERLYING trigger on the adverse side is pushed out to at least K noise units (FLOOR_HARD_EXIT_N,
 * the hard floor's own K) from the fixed reference: the floor's arm point, else the best point, else the
 * underlying the judge saw. Protective-side direction only; a PREMIUM trigger and an unknown N pass unchanged.
 */
export interface TriggerFloorInput {
  instrument: 'UNDERLYING' | 'PREMIUM';
  op: 'BELOW' | 'ABOVE';
  price: number;
  exposure: Exposure | null;
  floorArmUnderlying: number | null;
  bestUnderlying: number | null;
  underlyingNow: number | null;
  nUnderlying: number | null;
  k: number;
}

export function widenExitTrigger(i: TriggerFloorInput): { price: number; widenedFrom: number | null; ref: number | null } {
  const same = { price: i.price, widenedFrom: null, ref: null };
  if (i.instrument !== 'UNDERLYING' || i.exposure === null || !fin(i.nUnderlying) || i.nUnderlying <= 0 || !fin(i.k) || i.k <= 0) return same;
  const protective = i.exposure === 'BULLISH' ? i.op === 'BELOW' : i.op === 'ABOVE';
  const ref = [i.floorArmUnderlying, i.bestUnderlying, i.underlyingNow].find(fin) ?? null;
  if (!protective || ref === null) return same;
  const gap = i.k * i.nUnderlying;
  const limit = r2(i.exposure === 'BULLISH' ? ref - gap : ref + gap);
  const tooClose = i.exposure === 'BULLISH' ? i.price > limit : i.price < limit;
  return tooClose ? { price: limit, widenedFrom: i.price, ref } : { ...same, ref };
}
