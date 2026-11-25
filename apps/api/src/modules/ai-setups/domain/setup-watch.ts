import { floorToTick } from '../../signal-trader/domain/gate';
import type { SetupPlan } from './setup.types';

/**
 * The setup watch's rules (pure): a PENDING setup's entry and a FILLED setup's exits, judged on the
 * UNDERLYING's price (the setup's levels are underlying prices; the option is only what is traded).
 * The service (services/setup-watch.service.ts) reads the state from the DB, applies these, and makes each
 * transition with a conditional update on the row's status.
 */

export const BAR_15M_MS = 15 * 60_000;
/** A FILLED setup is closed this many minutes before its session's close at the latest (a minute ahead of the paper watch's square-off). */
export const SESSION_END_MINUTES = 6;

/** Exit reason tags this watch writes on the Trade row and the ai_setups row. */
export type SetupExitTag = 'AI_SETUP_SL' | 'AI_SETUP_TARGET' | 'AI_SETUP_TIME';

/** A closed 15m bar of the underlying (ts = bar start, ms). */
export interface Bar15m {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** The FILLED setup's watch state, stored in ai_setups.setup.watch (restart-safe). */
export interface SetupWatchState {
  /** The underlying stop now in force (the setup's SL, or the worst-fill entry level after T1). */
  sl: number;
  /** T1 was reached and the SL moved to the worst-fill entry level. */
  trailed: boolean;
  /** The underlying worst-fill entry level (zone top for a CE pullback, …): where T1 moves the SL. */
  worstFill: number;
  /** The underlying LTP that filled the entry. */
  entryUnderlying?: number | null;
  /** The option premium the paper trade was opened at (informational). */
  entryPremium?: number | null;
  trailedAt?: string | null;
}

const isBull = (s: SetupPlan) => s.instrument.optionType === 'CE';
const r2 = (n: number) => Math.round(n * 100) / 100;
/** The underlying at / beyond `level` on the stop side (≤ for a CE view, ≥ for a PE view). */
const stopCrossed = (bull: boolean, px: number, level: number) => (bull ? px <= level : px >= level);
/** The underlying at / beyond `level` on the target side. */
const reached = (bull: boolean, px: number, level: number) => (bull ? px >= level : px <= level);

/** Closed bars (start + 15 min ≤ now) that closed after the setup was made (start + 15 min > createdAt), oldest first. */
export function closedBarsSince(bars: readonly Bar15m[], createdAt: Date, now: Date): Bar15m[] {
  return bars
    .filter((b) => [b.ts, b.open, b.high, b.low, b.close].every((v) => typeof v === 'number' && Number.isFinite(v)))
    .filter((b) => b.ts + BAR_15M_MS <= now.getTime() && b.ts + BAR_15M_MS > createdAt.getTime())
    .sort((a, b) => a.ts - b.ts);
}

export type PendingStep = { action: 'WAIT'; reason: string } | { action: 'FILL'; reason: string } | { action: 'EXPIRE'; reason: string };

/**
 * A PENDING setup on this pass. Order: validUntil passed → EXPIRE; no LTP → WAIT; the SL already crossed (the LTP,
 * or a closed 15m bar since the setup) → EXPIRE (it never fills after that); then the entry condition:
 * LIMIT_PULLBACK — the LTP inside [low, high]; BREAKOUT_TRIGGER — a CLOSED 15m bar since the setup closing beyond
 * the trigger (`bars15m` null = not read this pass ⇒ WAIT); MARKET_NOW — at once.
 */
export function pendingStep(i: {
  setup: SetupPlan;
  ltp: number | null;
  now: Date;
  validUntil: Date | null;
  createdAt: Date;
  bars15m?: readonly Bar15m[] | null;
}): PendingStep {
  const s = i.setup;
  const bull = isBull(s);
  if (!i.validUntil || i.now.getTime() >= i.validUntil.getTime()) {
    return { action: 'EXPIRE', reason: `VALID_UNTIL_PASSED: valid until ${s.validUntil} IST passed, the ${s.entry.type} entry was never met` };
  }
  const ltp = i.ltp;
  if (ltp === null || !(ltp > 0)) return { action: 'WAIT', reason: 'no underlying price this pass' };
  if (stopCrossed(bull, ltp, s.sl)) {
    return { action: 'EXPIRE', reason: `SL_CROSSED_BEFORE_ENTRY: underlying ${ltp} is ${bull ? 'at / below' : 'at / above'} the SL ${s.sl} before the entry filled` };
  }
  const bars = i.bars15m ? closedBarsSince(i.bars15m, i.createdAt, i.now) : null;
  const through = bars?.find((b) => stopCrossed(bull, bull ? b.low : b.high, s.sl));
  if (through) {
    return { action: 'EXPIRE', reason: `SL_CROSSED_BEFORE_ENTRY: the 15m bar from ${new Date(through.ts).toISOString()} reached ${bull ? through.low : through.high} through the SL ${s.sl} before the entry filled` };
  }
  const e = s.entry;
  if (e.type === 'MARKET_NOW') return { action: 'FILL', reason: `MARKET_NOW at underlying ${ltp}` };
  if (e.type === 'LIMIT_PULLBACK') {
    return ltp >= e.low - 1e-9 && ltp <= e.high + 1e-9
      ? { action: 'FILL', reason: `LIMIT_PULLBACK: underlying ${ltp} inside ${e.low}–${e.high}` }
      : { action: 'WAIT', reason: `underlying ${ltp} outside ${e.low}–${e.high}` };
  }
  const trigger = e.trigger;
  if (trigger === null || !Number.isFinite(trigger)) return { action: 'WAIT', reason: 'BREAKOUT_TRIGGER without a trigger' };
  if (!bars) return { action: 'WAIT', reason: 'no closed 15m bars read' };
  const hit = bars.find((b) => (bull ? b.close > trigger : b.close < trigger));
  return hit
    ? { action: 'FILL', reason: `BREAKOUT_TRIGGER: the 15m bar from ${new Date(hit.ts).toISOString()} closed ${hit.close} ${bull ? 'above' : 'below'} ${trigger}; underlying ${ltp}` }
    : { action: 'WAIT', reason: `no closed 15m bar ${bull ? 'above' : 'below'} ${trigger} yet` };
}

/**
 * The underlying worst-fill entry level (owner 2026-11-25: R:R and ₹ risk are measured from it): the zone top for
 * a CE pullback (bottom for a PE); max(high, trigger) / min(low, trigger) for a breakout; the actual fill for
 * MARKET_NOW. T1 moves the SL here.
 */
export function worstFillLevel(s: SetupPlan, fillUnderlying: number): number {
  const bull = isBull(s);
  const e = s.entry;
  if (e.type === 'MARKET_NOW') return fillUnderlying;
  if (e.type === 'BREAKOUT_TRIGGER' && e.trigger !== null) return bull ? Math.max(e.high, e.trigger) : Math.min(e.low, e.trigger);
  return bull ? e.high : e.low;
}

export type FilledStep =
  | { action: 'HOLD' }
  | { action: 'TRAIL'; sl: number; reason: string }
  | { action: 'CLOSE'; tag: SetupExitTag; reason: string };

/**
 * A FILLED setup on this pass. Order: validUntil passed or the session ends within SESSION_END_MINUTES →
 * AI_SETUP_TIME (no price needed); no LTP → HOLD; the stop in force crossed → AI_SETUP_SL; the last target reached
 * → AI_SETUP_TARGET; T1 reached (more targets left, not yet trailed) → TRAIL the SL to the worst-fill entry level.
 */
export function filledStep(i: {
  setup: SetupPlan;
  watch: SetupWatchState;
  ltp: number | null;
  now: Date;
  validUntil: Date | null;
  minutesToClose: number | null;
}): FilledStep {
  const s = i.setup;
  const bull = isBull(s);
  if (i.validUntil && i.now.getTime() >= i.validUntil.getTime()) {
    return { action: 'CLOSE', tag: 'AI_SETUP_TIME', reason: `valid until ${s.validUntil} IST reached (underlying ${i.ltp ?? 'no price'})` };
  }
  if (i.minutesToClose !== null && i.minutesToClose <= SESSION_END_MINUTES) {
    return { action: 'CLOSE', tag: 'AI_SETUP_TIME', reason: `session ends in ${i.minutesToClose} min (underlying ${i.ltp ?? 'no price'})` };
  }
  const ltp = i.ltp;
  if (ltp === null || !(ltp > 0)) return { action: 'HOLD' };
  const sl = i.watch.sl;
  if (stopCrossed(bull, ltp, sl)) {
    return { action: 'CLOSE', tag: 'AI_SETUP_SL', reason: `underlying ${ltp} crossed the ${i.watch.trailed ? 'trailed (worst-fill entry) ' : ''}SL ${sl}` };
  }
  const ts = s.targets;
  const last = ts[ts.length - 1];
  if (last !== undefined && reached(bull, ltp, last)) {
    return { action: 'CLOSE', tag: 'AI_SETUP_TARGET', reason: `underlying ${ltp} reached the last target T${ts.length} ${last}` };
  }
  const level = i.watch.worstFill;
  if (!i.watch.trailed && ts.length > 1 && reached(bull, ltp, ts[0]) && (bull ? level > sl : level < sl)) {
    return { action: 'TRAIL', sl: r2(level), reason: `underlying ${ltp} reached T1 ${ts[0]}: SL ${sl} → ${r2(level)} (worst-fill entry level)` };
  }
  return { action: 'HOLD' };
}

/**
 * The paper trade's PREMIUM stop: the catastrophe floor only — the premium at which 1 lot loses the class ceiling
 * (`ceiling` ₹ / (qty × contract value factor) below the fill), on the tick, at least one tick. The setup's own
 * stop is the underlying SL; this premium stop only stands behind it (the generic paper watch acts on it).
 */
export function premiumFloorSl(i: { ltp: number; ceiling: number; qty: number; valueFactor: number; tick: number }): number {
  const tick = i.tick > 0 ? i.tick : 0.05;
  const per = i.qty * (i.valueFactor > 0 ? i.valueFactor : 1);
  const raw = per > 0 ? i.ltp - i.ceiling / per : 0;
  return Math.max(tick, floorToTick(raw, tick));
}
