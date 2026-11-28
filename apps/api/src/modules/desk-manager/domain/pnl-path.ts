import { isHeld } from '../../sentinel-executor/domain/guards';
import type { ClosedTrade, DayPnlPath, TradeOrigin } from './desk.types';

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The ONE reading of an open position's P&L: the tracker's marked pnl, exactly the value the packet's positions
 * block shows (a missing / non-finite pnl reads 0 here). The guard used a second reading (today's move only for a
 * carried position) and on 2026-11-27 showed open −3,521 while the positions block showed MAZDOCK −4,399.
 */
export function positionOpenPnl(pnl: number | null | undefined): number {
  return typeof pnl === 'number' && Number.isFinite(pnl) ? pnl : 0;
}

/** One live open position as the guard reads it. */
export interface GuardOpenTrade {
  trackerId: string;
  symbol: string;
  pnl: number | null;
  origin: TradeOrigin;
}

/** The P&L the guard does NOT count (owner manual / held / non-desk trades) — reported, never decided on. */
export interface OwnerPnl {
  realised: number;
  open: number;
}

/** The guard's day path plus the excluded P&L, so the supreme still sees the whole desk. */
export type GuardDayPath = DayPnlPath & { ownerPnl: OwnerPnl };

/**
 * A trade the guard counts: opened by a desk OPEN decision (origin 'manager') and not on the owner's hold list
 * (AI_AUTO_EXIT_HOLD, by symbol or tracker id). Owner manual trades, held positions, signal / reentry / unknown
 * origins are excluded (2026-11-27: the owner's held MAZDOCK put and 3 manual losers blocked the desk ~270 min
 * on a +₹2,409 desk day). Holdings and paper never reach the guard (the repository reads POSITION, non-paper).
 */
export function countsForGuard(t: { trackerId: string; symbol: string; origin: TradeOrigin }, hold: readonly string[]): boolean {
  return t.origin === 'manager' && !isHeld([...hold], { id: t.trackerId, symbol: t.symbol });
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
 * The guard's path from ONLY the desk's own trades (countsForGuard); everything else is summed into ownerPnl.
 * Open P&L per position is positionOpenPnl (the positions-block value).
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
    const v = positionOpenPnl(p.pnl);
    if (countsForGuard(p, hold)) mineOpen += v;
    else ownerOpen += v;
  }
  return { ...dayPnlPath(mine, mineOpen), ownerPnl: { realised: r2(ownerRealised), open: r2(ownerOpen) } };
}
