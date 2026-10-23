/**
 * Paper (no funds) vs live signal trades, side by side (the page and the self-review). Pure.
 * A trade is a WIN when its P&L is > 0, a LOSS when < 0; open trades count their mark-to-market
 * P&L in `pnl` but not in wins/losses.
 */
export interface TradeOutcomeSummary {
  n: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  /** Rows with no trade (paper could not be opened / live order never filled). */
  noTrade: number;
  /** ₹ closed + open (mark) P&L. */
  pnl: number;
  /** ₹ closed P&L only. */
  realised: number;
  /** wins / (wins + losses) of the closed trades; null when none closed. */
  winRate: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function summarise(rows: Array<{ open: boolean; pnl: number | null } | null>): TradeOutcomeSummary {
  const s: TradeOutcomeSummary = { n: rows.length, open: 0, closed: 0, wins: 0, losses: 0, noTrade: 0, pnl: 0, realised: 0, winRate: null };
  for (const r of rows) {
    if (!r) {
      s.noTrade += 1;
      continue;
    }
    const p = typeof r.pnl === 'number' && Number.isFinite(r.pnl) ? r.pnl : 0;
    s.pnl += p;
    if (r.open) {
      s.open += 1;
      continue;
    }
    s.closed += 1;
    s.realised += p;
    if (p > 0) s.wins += 1;
    else if (p < 0) s.losses += 1;
  }
  s.pnl = r2(s.pnl);
  s.realised = r2(s.realised);
  s.winRate = s.wins + s.losses > 0 ? r2(s.wins / (s.wins + s.losses)) : null;
  return s;
}

/** Paper trades (Trade rows; null = no paper trade for that decision). */
export function paperSummary(trades: Array<{ status: string; pnl: number | null } | null>): TradeOutcomeSummary {
  return summarise(trades.map((t) => (t ? { open: t.status !== 'CLOSED', pnl: t.pnl } : null)));
}

/** Live signal orders: only a FILLED / PARTIAL entry is a trade; its tracker carries the P&L. */
export function liveSummary(orders: Array<{ status: string; trackerStatus: string | null; pnl: number | null }>): TradeOutcomeSummary {
  const filled = orders.filter((o) => o.status === 'FILLED' || o.status === 'PARTIAL');
  const s = summarise(filled.map((o) => ({ open: o.trackerStatus !== 'CLOSED', pnl: o.pnl })));
  return { ...s, noTrade: orders.length - filled.length, n: orders.length };
}
