/**
 * Exit discipline §8 (R10): what the price did after an exit decision.
 * Pure. Positive missed = rupees left on the table by exiting; positive saved =
 * rupees a hold would have lost; positive netAtEnd = holding to the window end
 * would have been better.
 */
import type { MinuteBar, PositionSide } from './types';

export interface ExitOutcomeValues {
  barsUsed: number; maxAfter: number; minAfter: number;
  closeAt15: number | null; closeAt30: number | null; closeAt60: number | null; closeAtEnd: number;
  missedPnl: number; savedPnl: number; netAtEnd: number;
}
const MIN = 60_000;

/** min(decisionAt + window, exchange close). */
export function outcomeWindowEnd(decisionAt: Date, windowMin: number, closeAt: Date | null): Date {
  const end = decisionAt.getTime() + windowMin * MIN;
  return new Date(closeAt ? Math.min(end, closeAt.getTime()) : end);
}

/** Bars strictly after the decision's own minute and starting before the window end. */
function used(bars: MinuteBar[], decisionAt: Date, windowEnd: Date): MinuteBar[] {
  const first = Math.floor(decisionAt.getTime() / MIN) * MIN + MIN;
  return bars
    .filter((b) => [b.ts, b.high, b.low, b.close].every(Number.isFinite) && b.ts >= first && b.ts < windowEnd.getTime())
    .sort((a, b) => a.ts - b.ts);
}

/** ≥ 1 bar starting within 3 min of the end AND ≥ 50 % of the window's whole minutes. */
export function isWindowCovered(bars: MinuteBar[], from: Date, to: Date): boolean {
  const u = used(bars, from, to);
  const minutes = Math.max(1, Math.floor((to.getTime() - from.getTime()) / MIN));
  return u.length > 0 && u[u.length - 1].ts >= to.getTime() - 3 * MIN && u.length >= 0.5 * minutes;
}

export function computeExitOutcome(i: {
  positionSide: PositionSide; qty: number; decisionPrice: number; decisionAt: Date; windowEnd: Date; bars: MinuteBar[];
}): ExitOutcomeValues | null {
  const u = used(i.bars, i.decisionAt, i.windowEnd);
  if (u.length === 0 || !Number.isFinite(i.decisionPrice) || !Number.isFinite(i.qty)) return null;
  const maxAfter = Math.max(...u.map((b) => b.high));
  const minAfter = Math.min(...u.map((b) => b.low));
  const closeBy = (k: number): number | null => {
    const limit = i.decisionAt.getTime() + k * MIN;
    if (limit > i.windowEnd.getTime()) return null; // the window (exchange close) ended first
    const hit = u.filter((b) => b.ts + MIN <= limit);
    return hit.length ? hit[hit.length - 1].close : null;
  };
  const closeAtEnd = u[u.length - 1].close;
  const dp = i.decisionPrice;
  const long = i.positionSide === 'LONG';
  const missed = Math.max(0, long ? maxAfter - dp : dp - minAfter) * i.qty;
  const saved = Math.max(0, long ? dp - minAfter : maxAfter - dp) * i.qty;
  return {
    barsUsed: u.length, maxAfter, minAfter,
    closeAt15: closeBy(15), closeAt30: closeBy(30), closeAt60: closeBy(60), closeAtEnd,
    missedPnl: missed, savedPnl: saved, netAtEnd: (closeAtEnd - dp) * i.qty * (long ? 1 : -1),
  };
}
