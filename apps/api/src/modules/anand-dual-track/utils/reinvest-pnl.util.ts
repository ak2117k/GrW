/**
 * Live (mark-to-market) P&L helpers for reinvestment lots.
 *
 * A lot's capital is the ₹20k swing profit redeployed into the same symbol, so
 * its return scales linearly with price: a lot up x% is up x% × capital. These
 * pure helpers keep that arithmetic in one place, shared by the `/reinvest/lots`
 * (per-row) and `/reinvest/pool` (aggregate Unrealized P&L) endpoints.
 */

/** Mark one lot to a current price. */
export function computeLotLivePnl(
  lot: { entryPrice: number; capital: number },
  currentPrice: number,
): { currentPrice: number; pnlPct: number; pnlRs: number } {
  const pnlPct = ((currentPrice - lot.entryPrice) / lot.entryPrice) * 100;
  const pnlRs = (pnlPct / 100) * lot.capital;
  return { currentPrice, pnlPct, pnlRs };
}

/**
 * Sum live unrealized P&L across OPEN lots only. Closed lots (TARGET_HIT /
 * STOPPED) are excluded — their P&L is already realized and booked into the
 * pool's `realizedPnl`, so counting them here would double-count.
 */
export function sumOpenLotsUnrealizedPnl(
  lots: Array<{
    entryPrice: number;
    capital: number;
    status: string;
    currentPrice: number;
  }>,
): number {
  return lots
    .filter((l) => l.status === 'OPEN')
    .reduce((sum, l) => sum + computeLotLivePnl(l, l.currentPrice).pnlRs, 0);
}
