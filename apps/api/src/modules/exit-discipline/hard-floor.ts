import { FLOOR_HARD_CONFIRM_SEC, FLOOR_HARD_REFIRE_SEC } from './config';
import type { Exposure, NoiseOpinion, PositionSide } from './types';

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
 *  - FLOOR_BREAK_GREEN (FLOOR_LOCK_GREEN, owner-approved 2026-11-04): the floor is broken and the
 *    position is still net green — lock the green in, no underlying move required. Prod 2026-11-04
 *    NIFTY 23650 PE: below the armed floor at +₹212 and +₹63, held because NIFTY was 1.8 N (< K) from
 *    the best point, then sold by GREEN_TO_RED at −₹664. HWM_UNDERLYING_MOVE now fires only when the
 *    green lock is off, the net P&L is unknown, or a NOISE opinion holds the green break.
 *
 * A trip sells only once confirmed (`confirmHardFloor`): it must hold on two consecutive cycle reads
 * at least FLOOR_HARD_CONFIRM_SEC apart, so one print through the floor never sells. The exit goes
 * through the same verdict → executor → gate path as an AI EXIT_NOW (owner HOLD, F&O only, the cap).
 */
export type HardFloorRule = 'GREEN_TO_RED' | 'FLOOR_BREAK_GREEN' | 'HWM_UNDERLYING_MOVE' | 'MAX_LOSS';

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
  /** FLOOR_LOCK_GREEN: a broken floor that is still net green trips (FLOOR_BREAK_GREEN). Absent = off. */
  lockGreen?: boolean;
  /**
   * The decision point's noise opinion (types.ts NoiseOpinion). Honoured ONLY by FLOOR_BREAK_GREEN: a
   * NOISE opinion holds a green floor break (the K·N rule and GREEN_TO_RED still apply). Null / UNKNOWN
   * / REAL ⇒ the green lock trips, exactly the code rule.
   */
  noise?: NoiseOpinion | null;
  /**
   * FLOOR_NOISE_CONFIRM_N: GREEN_TO_RED / FLOOR_BREAK_GREEN need the underlying at least this many noise units
   * against the position from its best point. Absent / 0 ⇒ off (the price-only rule, as before).
   */
  noiseConfirmN?: number;
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
  /** The floor is broken but the underlying moved < noiseConfirmN units against: the contract's noise, held. */
  noiseHeld?: boolean;
  /** MAX_LOSS only: the hard loss reading that tripped (band, reference, move) — for the reason and the audit. */
  loss?: HardLossReading;
}

export function hardFloorReading(i: HardFloorInput): HardFloorReading {
  const fp = i.floor.price;
  const belowFloor = i.floor.armed && fin(fp) && fin(i.ltp) ? (i.side === 'LONG' ? i.ltp < fp : i.ltp > fp) : false;
  const netRed = fin(i.netPnl) && i.netPnl < 0;
  const adverse = underlyingAgainst(i.exposure, i.bestUnderlying, i.underlying);
  const n = fin(i.nUnderlying) && i.nUnderlying > 0 ? i.nUnderlying : null;
  const adverseN = adverse !== null && n !== null ? r2(adverse / n) : null;
  const moved = adverse !== null && n !== null && fin(i.k) && i.k > 0 && adverse >= i.k * n - 1e-9;
  const green = fin(i.netPnl) && i.netPnl >= 0;
  const lock = i.lockGreen === true && green && i.noise?.verdict !== 'NOISE';
  // The noise test (FLOOR_NOISE_CONFIRM_N): known underlying, known unit, less than c units against ⇒ noise.
  const c = fin(i.noiseConfirmN) && i.noiseConfirmN > 0 ? i.noiseConfirmN : 0;
  const noiseHeld = belowFloor && c > 0 && adverse !== null && n !== null && adverse < c * n - 1e-9;
  const rule: HardFloorRule | null = !belowFloor
    ? null
    : moved
      ? netRed ? 'GREEN_TO_RED' : lock ? 'FLOOR_BREAK_GREEN' : 'HWM_UNDERLYING_MOVE'
      : noiseHeld
        ? null
        : netRed ? 'GREEN_TO_RED' : lock ? 'FLOOR_BREAK_GREEN' : null;
  return { trip: rule !== null, rule, belowFloor, netRed, adverseFromBest: adverse, adverseFromBestN: adverseN, ...(noiseHeld ? { noiseHeld: true } : {}) };
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

/**
 * HARD LOSS EXIT (owner 2026-11-03, going live: "for real close the trade on a loss of 2 k"). Pure.
 * The entry risk cap is relaxed for live signal trades (SIGNAL_RISK_CAP_GATE=off), so the per-trade
 * loss is capped at the exit instead: a REAL derivative position whose net P&L after charges is at or
 * below −HARD_LOSS_EXIT_RUPEES exits, confirmed like the hard floor (two reads ≥ FLOOR_HARD_CONFIRM_SEC
 * apart). 0 / unset = off. Paper trades are untouched.
 */
export function hardLossLimit(env: Record<string, string | undefined> = process.env): number | null {
  const n = Number(String(env.HARD_LOSS_EXIT_RUPEES ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function hardLossTrip(netPnl: number | null | undefined, limit: number | null): boolean {
  return limit !== null && fin(netPnl) && netPnl <= -limit;
}

/** HARD_LOSS_CAP_RUPEES default: the absolute per-trade loss exit (no conditions). */
export const HARD_LOSS_CAP_DEFAULT_RUPEES = 3000;
/** HARD_LOSS_NOISE_N default: the underlying move, in its own noise units, that makes a ₹2k–cap loss real. */
export const HARD_LOSS_NOISE_N_DEFAULT = 3;

/**
 * NOISE-AWARE HARD LOSS (owner-approved 2026-11-04). Prod 2026-11-04 NIFTY09NOV2623750PE (2 lots):
 * the plain ₹2k rule sold at 142.1 (net −₹2299) with NIFTY only 1.83 N against the position; the
 * premium bottomed at 137.2 two minutes later and ran to 184 by 11:36. A ₹2k loss inside ordinary
 * noise is not a reason to sell; a ₹2k loss with the underlying clearly moved is.
 *
 *  - limit: HARD_LOSS_EXIT_RUPEES (unset / 0 / junk = the whole hard loss exit OFF, as before).
 *  - cap:   HARD_LOSS_CAP_RUPEES (default 3000; 0 = no cap). Absolute: at or below −cap it exits.
 *  - noiseN: HARD_LOSS_NOISE_N (default 3; 0 = no noise band). Between −limit and −cap the trade exits
 *    only once the underlying is ≥ noiseN N against the position from its reference.
 * The band is used only with a cap ABOVE the limit and noiseN > 0 — any other combination is the plain
 * rule (net ≤ −limit, or the tighter cap), so a misconfiguration can never leave a loss uncapped.
 */
export interface HardLossConfig { limit: number | null; cap: number | null; noiseN: number | null }

function envNum(raw: string | undefined, fallback: number): number | null {
  const s = String(raw ?? '').trim();
  if (s === '') return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n === 0 ? null : n;
}

/**
 * PER UNDERLYING (owner 2026-11-04, "GOLD loss limit ₹7.5k"): `perUnderlying` is the position's
 * lossLimitFor(symbol) (common/utils/loss-limit.ts — resolved by the caller, this module stays pure:
 * HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING, code default GOLD:7500, `off` = rollback). A listed underlying has
 * limit = cap, so hardLossBandOn is false and it is the plain rule. Absent = the config before 2026-11-04.
 */
export function hardLossConfig(
  env: Record<string, string | undefined> = process.env,
  perUnderlying: { limit: number | null; cap: number | null } | null = null,
): HardLossConfig {
  const noiseN = envNum(env.HARD_LOSS_NOISE_N, HARD_LOSS_NOISE_N_DEFAULT);
  if (perUnderlying) return { limit: perUnderlying.limit, cap: perUnderlying.cap, noiseN };
  return { limit: hardLossLimit(env), cap: envNum(env.HARD_LOSS_CAP_RUPEES, HARD_LOSS_CAP_DEFAULT_RUPEES), noiseN };
}

/** True when the ₹limit–₹cap band is noise-aware (else the plain rule). */
export function hardLossBandOn(c: HardLossConfig): boolean {
  return c.limit !== null && c.cap !== null && c.cap > c.limit && c.noiseN !== null && c.noiseN > 0;
}

export type HardLossBand =
  /** net ≤ −cap: absolute. */
  | 'CAP'
  /** In the band and the underlying ≥ noiseN N against the position. */
  | 'BAND_UNDERLYING'
  /** In the band, the move unmeasurable (no N, no underlying, no reference) ⇒ the plain ₹limit rule: fail safe. */
  | 'BAND_UNMEASURED'
  /** In the band and a noise opinion said REAL. */
  | 'BAND_REAL'
  /** The band is off (see hardLossBandOn): net ≤ −limit, as before 2026-11-04. */
  | 'PLAIN';
export type HardLossHold = 'HOLD_UNDER_N' | 'HOLD_NOISE';

export interface HardLossInput {
  netPnl: number | null | undefined;
  cfg: HardLossConfig;
  exposure: Exposure | null;
  underlying: number | null;
  /** The underlying's 1-minute close at the position's entry (null when not stored). */
  entryUnderlying: number | null;
  /** The underlying at the position's best point (FloorAnchors.best.underlying) — the fallback reference. */
  bestUnderlying: number | null;
  nUnderlying: number | null;
  /**
   * The decision point's noise opinion (types.ts NoiseOpinion). Honoured ONLY inside the band: REAL ⇒
   * exit, NOISE ⇒ hold to the cap. Never at the cap. Null / UNKNOWN ⇒ the noiseN underlying test.
   */
  noise?: NoiseOpinion | null;
}

export interface HardLossReading {
  trip: boolean;
  /** Why it tripped, or why a loss at/over the limit is being held; null when not at the limit. */
  band: HardLossBand | HardLossHold | null;
  /** Which reference the underlying move is measured from. */
  ref: 'ENTRY' | 'BEST' | null;
  adverse: number | null;
  adverseN: number | null;
  /** The thresholds in force (rupees, N). */
  limit: number | null;
  cap: number | null;
  noiseN: number | null;
}

/**
 * The move is measured from the position's ENTRY underlying (the 1-minute close at entry): the loss is
 * measured from entry, so the move that matches it is the move since entry. Without one, from the BEST
 * point: the best is at least as favourable as entry, so the move from it is at least as large — the
 * fallback can only exit sooner, never later. Pure.
 */
export function hardLossReading(i: HardLossInput): HardLossReading {
  const { limit, cap, noiseN } = i.cfg;
  const refU = fin(i.entryUnderlying) ? i.entryUnderlying : fin(i.bestUnderlying) ? i.bestUnderlying : null;
  const ref = fin(i.entryUnderlying) ? 'ENTRY' : fin(i.bestUnderlying) ? 'BEST' : null;
  const adverse = underlyingAgainst(i.exposure, refU, i.underlying);
  const n = fin(i.nUnderlying) && i.nUnderlying > 0 ? i.nUnderlying : null;
  const adverseN = adverse !== null && n !== null ? r2(adverse / n) : null;
  const out = (trip: boolean, band: HardLossReading['band']): HardLossReading => ({ trip, band, ref, adverse, adverseN, limit, cap, noiseN });
  if (limit === null || !fin(i.netPnl)) return out(false, null);
  const net = i.netPnl;
  if (!hardLossBandOn(i.cfg)) {
    const plain = cap !== null ? Math.min(limit, cap) : limit;
    return net <= -plain ? out(true, cap !== null && cap < limit ? 'CAP' : 'PLAIN') : out(false, null);
  }
  if (net <= -(cap as number)) return out(true, 'CAP');
  if (net > -limit) return out(false, null);
  const v = i.noise?.verdict;
  if (v === 'REAL') return out(true, 'BAND_REAL');
  if (v === 'NOISE') return out(false, 'HOLD_NOISE');
  if (adverse === null || n === null) return out(true, 'BAND_UNMEASURED');
  return adverse >= (noiseN as number) * n - 1e-9 ? out(true, 'BAND_UNDERLYING') : out(false, 'HOLD_UNDER_N');
}
