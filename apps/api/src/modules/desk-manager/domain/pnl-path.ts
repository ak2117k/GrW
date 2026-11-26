import type { ClosedTrade, DayPnlPath } from './desk.types';

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
