import { isHeld } from '../../sentinel-executor/domain/guards';
import type { ClosedTrade, DayPnlPath, TradeOrigin } from './desk.types';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A finite pnl, else 0 (a missing pnl never ends a streak or moves the path by NaN). */
export function positionOpenPnl(pnl: number | null | undefined): number {
  return typeof pnl === 'number' && Number.isFinite(pnl) ? pnl : 0;
}

/**
 * Today's share of an open position's P&L when it was opened on an EARLIER IST day: the move from the previous
 * session's close to the live price, not the whole loss since entry (2026-11-27: a PE held from 11-25 put its
 * earlier-day loss into today's drawdown). Scaled by the tracker's own pnl per point (pnl / (ltp − entry)), so a
 * contract value factor (MCX minis) is kept; qty only when ltp equals entry. No previous close or no price →
 * the full pnl (the old, stricter reading), never 0.
 */
export function carriedTodayPnl(p: { pnl: number; entryPrice: number; ltp: number | null; qty: number; prevClose: number | null }): number {
  const pnl = Number.isFinite(p.pnl) ? p.pnl : 0;
  const ltp = p.ltp;
  if (p.prevClose === null || !Number.isFinite(p.prevClose) || p.prevClose <= 0) return pnl;
  if (ltp === null || !Number.isFinite(ltp) || !Number.isFinite(p.entryPrice)) return pnl;
  const diff = ltp - p.entryPrice;
  const perPoint = Math.abs(diff) > 1e-9 ? pnl / diff : p.qty;
  if (!Number.isFinite(perPoint)) return pnl;
  return (ltp - p.prevClose) * perPoint;
}

/**
 * One live open position as the guard reads it. `pnl` = since entry (the positions-block value); `todayPnl` =
 * what the DAY guard counts: the whole pnl for a position opened today, today's move only (carriedTodayPnl) for
 * one carried in from an earlier IST day.
 */
export interface GuardOpenTrade {
  trackerId: string;
  symbol: string;
  pnl: number | null;
  todayPnl: number;
  origin: TradeOrigin;
}

/** The P&L the guard does NOT count (owner manual / held trades) — reported, never decided on. Open = today's move. */
export interface OwnerPnl {
  realised: number;
  open: number;
}

/** The guard's day path plus the excluded P&L, so the supreme still sees the whole desk. */
export type GuardDayPath = DayPnlPath & { ownerPnl: OwnerPnl };

/**
 * A trade the guard counts: any of the APP's own automated trades (desk manager, signal trader, reentry — every
 * origin with a signal_orders row) that is not on the owner's hold list (AI_AUTO_EXIT_HOLD, by symbol or tracker
 * id). Excluded: the owner's manual trades (no order row) and held positions (2026-11-27: the owner's held MAZDOCK
 * put and 3 manual losers blocked the desk ~270 min on a +₹2,409 day). Holdings and paper never reach the guard
 * (the repository reads POSITION, non-paper).
 */
// The hold list is read at check time: a contract the owner adds to AI_AUTO_EXIT_HOLD mid-day drops ALL its trades
// today (open and already closed, losers included) out of the guard path into ownerPnl — the owner's call
// (removing it from the list puts them back).
export function countsForGuard(t: { trackerId: string; symbol: string; origin: TradeOrigin }, hold: readonly string[]): boolean {
  return t.origin !== 'manual' && !isHeld([...hold], { id: t.trackerId, symbol: t.symbol });
}

/**
 * The day's P&L path for the desk guard and the manager's packet: realised (closed trades in exit order) plus
 * the open P&L now. Peak = the best the day has been (never below 0: a day that never went green peaks at 0),
 * drawdown = peak − total, lossStreak = trailing consecutive losers (a flat trade ends the streak).
 */
export function dayPnlPath(closed: readonly ClosedTrade[], openPnl: number): DayPnlPath {
  const sorted = [...closed].sort((a, b) => a.exitAt.getTime() - b.exitAt.getTime());
  const open = Number.isFinite(openPnl) ? openPnl : 0;
  let running = 0;
  let peak = 0;
  for (const t of sorted) {
    running += Number.isFinite(t.pnl) ? t.pnl : 0;
    if (running > peak) peak = running;
  }
  const realised = running;
  const total = realised + open;
  if (total > peak) peak = total;
  let lossStreak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].pnl < 0) lossStreak++;
    else break;
  }
  return { realised: r2(realised), open: r2(open), total: r2(total), peak: r2(peak), drawdownFromPeak: r2(peak - total), lossStreak, closed: sorted };
}

/**
 * The guard's path from ONLY the app's own, non-held trades (countsForGuard); the owner's manual and held trades
 * are summed into ownerPnl. Open P&L per position is its todayPnl (a day guard: a carried position adds only
 * today's move).
 */
export function guardDayPath(closed: readonly ClosedTrade[], open: readonly GuardOpenTrade[], hold: readonly string[]): GuardDayPath {
  const mine: ClosedTrade[] = [];
  let ownerRealised = 0;
  for (const t of closed) {
    if (countsForGuard(t, hold)) mine.push(t);
    else ownerRealised += Number.isFinite(t.pnl) ? t.pnl : 0;
  }
  let mineOpen = 0;
  let ownerOpen = 0;
  for (const p of open) {
    const v = positionOpenPnl(p.todayPnl);
    if (countsForGuard(p, hold)) mineOpen += v;
    else ownerOpen += v;
  }
  return { ...dayPnlPath(mine, mineOpen), ownerPnl: { realised: r2(ownerRealised), open: r2(ownerOpen) } };
}
