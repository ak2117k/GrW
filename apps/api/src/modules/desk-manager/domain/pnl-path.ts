import type { ClosedTrade, DayPnlPath } from './desk.types';

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
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { realised: r2(realised), open: r2(open), total: r2(total), peak: r2(peak), drawdownFromPeak: r2(peak - total), lossStreak, closed: sorted };
}
