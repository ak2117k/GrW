import type { SessionClock } from '../../market-hub/session-clock';
import { istDate, nextDate } from '../execution/ledger-math';
import { hhmmToMinutes } from '../risk-wall/limits/limit-keys';
import { istMinutesOf } from '../risk-wall/session-open';
import type { Vehicle } from '../strategies/blocks/block-types';
import type { CorePosition, ExitReason } from './lifecycle.types';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Owner decision O2: these vehicles square off every day. */
export const INTRADAY_VEHICLES: readonly Vehicle[] = ['CASH_INTRADAY', 'OPTIONS_BUY'];

/** O4: the earlier of the frozen and the live square-off time; a loosening never extends. */
export function effectiveSquareOff(frozen: string, live: string | null): string {
  if (live === null || !HHMM.test(live)) return frozen;
  return hhmmToMinutes(live) < hhmmToMinutes(frozen) ? live : frozen;
}

/** O4: the lower of the frozen and the live MTF hold limit; null for non-MTF positions. */
export function effectiveHoldDays(frozen: number | null, live: number | null): number | null {
  if (frozen === null) return null;
  return live !== null && Number.isSafeInteger(live) && live >= 1 && live < frozen ? live : frozen;
}

/** Bounds the calendar scan; every hold limit forces an exit far sooner. */
const MAX_DAYS_SCANNED = 60;

/** O5: exchange trading days strictly after the entry day, up to and including today (IST). */
export function tradingDaysHeld(clock: Pick<SessionClock, 'isTradingDay'>, exchange: string, entryDay: string, now: Date): number {
  const today = istDate(now);
  let day = entryDay;
  let n = 0;
  for (let i = 0; i < MAX_DAYS_SCANNED && day < today; i += 1) {
    day = nextDate(day);
    // 10:00 IST on that date: the clock judges the date, not the minute.
    if (clock.isTradingDay(exchange, new Date(`${day}T04:30:00.000Z`))) n += 1;
  }
  return n;
}

export type ExitView = Pick<
  CorePosition,
  | 'vehicle'
  | 'side'
  | 'plan'
  | 'openQty'
  | 'entryAvgPrice'
  | 'stopPrice'
  | 'initialStopPrice'
  | 'targetPrice'
  | 'partialPrice'
  | 'partialQty'
  | 'partialDone'
  | 'trailActive'
  | 'highWater'
  | 'openedAt'
>;

export interface ExitInputs {
  position: ExitView;
  /** A fresh (≤ PRICE_MAX_AGE_MS) price of the traded instrument, or null. */
  price: { ltp: number; at: number } | null;
  /** A fresh price of the option's underlying, or null. */
  underlyingLtp: number | null;
  now: Date;
  sessionOpen: boolean;
  killSwitchActive: boolean;
  /** effectiveSquareOff(plan.squareOffHhmm, live). */
  squareOffHhmm: string;
  /** effectiveHoldDays(plan.mtfMaxHoldDays, live). */
  mtfMaxHoldDays: number | null;
  tradingDaysHeld: number;
  /** The first fresh price since this process reloaded the position. */
  recovering: boolean;
  /** The first fresh price of this IST day for the position. */
  firstPriceOfDay: boolean;
}

export type ExitDecision =
  | { kind: 'NONE' }
  | { kind: 'EXIT'; reason: ExitReason; detail: string }
  | { kind: 'PARTIAL'; qty: number; detail: string };

const NONE: ExitDecision = { kind: 'NONE' };
const exit = (reason: ExitReason, detail: string): ExitDecision => ({ kind: 'EXIT', reason, detail });

/**
 * One position at one instant (spec §7.3, highest priority first): kill switch; the stop
 * (recovery, gap, trail or plain) and the underlying stop; target, then the partial; time
 * exit, expiry day, theta stop, hold limit; vehicle square-off. Daily loss (priority 2)
 * reaches positions through CORE_SQUARE_OFF (ruling L15). Price rules need a fresh price;
 * clock rules do not, so a blind position still squares off. Nothing while the session is
 * closed (ruling L9).
 */
export function decideExit(i: ExitInputs): ExitDecision {
  const p = i.position;
  if (!i.sessionOpen || p.openQty <= 0 || p.entryAvgPrice === null) return NONE;
  if (i.killSwitchActive) return exit('KILL_SWITCH', 'the kill switch is on');
  const buy = p.side === 'BUY';
  const ltp = i.price?.ltp ?? null;

  if (ltp !== null && p.stopPrice !== null && (buy ? ltp <= p.stopPrice : ltp >= p.stopPrice)) {
    const moved = p.trailActive || p.stopPrice !== p.initialStopPrice;
    const reason: ExitReason = i.recovering ? 'RECOVERY_STOP' : i.firstPriceOfDay ? 'GAP_STOP' : moved ? 'TRAIL' : 'STOP';
    return exit(reason, `${ltp} crossed the stop ${p.stopPrice}`);
  }
  const opt = p.plan.option;
  if (opt && opt.underlyingStopPrice !== null && i.underlyingLtp !== null) {
    const hit = opt.optionType === 'CE' ? i.underlyingLtp <= opt.underlyingStopPrice : i.underlyingLtp >= opt.underlyingStopPrice;
    if (hit) return exit('UNDERLYING_STOP', `the underlying at ${i.underlyingLtp} crossed ${opt.underlyingStopPrice}`);
  }
  if (ltp !== null && p.targetPrice !== null && (buy ? ltp >= p.targetPrice : ltp <= p.targetPrice)) {
    return exit('TARGET', `${ltp} reached the target ${p.targetPrice}`);
  }
  if (ltp !== null && !p.partialDone && p.partialPrice !== null && (buy ? ltp >= p.partialPrice : ltp <= p.partialPrice)) {
    const qty = p.partialQty > 0 && p.partialQty < p.openQty ? p.partialQty : 0;
    return { kind: 'PARTIAL', qty, detail: `${ltp} reached target 1 at ${p.partialPrice}` };
  }

  const minutes = istMinutesOf(i.now);
  const today = istDate(i.now);
  const atSquareOff = minutes >= hhmmToMinutes(i.squareOffHhmm);
  const te = p.plan.timeExit;
  if (te.kind === 'clock' && minutes >= hhmmToMinutes(te.hhmm)) return exit('TIME_EXIT', `time exit at ${te.hhmm} IST`);
  if (te.kind === 'holdDays' && i.tradingDaysHeld >= te.n && atSquareOff) {
    return exit('TIME_EXIT', `held ${i.tradingDaysHeld} trading days (time exit after ${te.n})`);
  }
  if (opt) {
    if (today > opt.expiry || (today === opt.expiry && minutes >= hhmmToMinutes(opt.expiryDayExitHhmm))) {
      return exit('EXPIRY_DAY', `expiry ${opt.expiry}: out by ${opt.expiryDayExitHhmm} IST, never held into expiry`);
    }
    if (p.openedAt) {
      const elapsedMin = (i.now.getTime() - p.openedAt.getTime()) / 60_000;
      const best = p.highWater ?? p.entryAvgPrice;
      const movePct = ((best - p.entryAvgPrice) / p.entryAvgPrice) * 100;
      if (elapsedMin >= opt.thetaStop.withinMinutes && movePct < opt.thetaStop.minMovePct) {
        return exit('THETA_STOP', `best premium move ${movePct.toFixed(2)} % < ${opt.thetaStop.minMovePct} % within ${opt.thetaStop.withinMinutes} min`);
      }
    }
  }
  if (i.mtfMaxHoldDays !== null && i.tradingDaysHeld >= i.mtfMaxHoldDays && atSquareOff) {
    return exit('HOLD_LIMIT', `held ${i.tradingDaysHeld} trading days; the MTF limit is ${i.mtfMaxHoldDays}`);
  }
  if (INTRADAY_VEHICLES.includes(p.vehicle) && (atSquareOff || today > p.plan.entryDay)) {
    return exit('SQUARE_OFF', today > p.plan.entryDay ? `an intraday position opened ${p.plan.entryDay} is still open` : `${p.vehicle} squares off at ${i.squareOffHhmm} IST`);
  }
  return NONE;
}
