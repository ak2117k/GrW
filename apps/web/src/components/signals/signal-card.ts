import type { AnandEntry } from '@/services/anand';

/** Pure P&L derivation for a signal card, mirroring the legacy IntradayPage
 *  row math (NOTIONAL-based rupee P&L; stale when an open row has no price). */
export function signalPnl(
  entry: AnandEntry,
  notional: number,
): { pnlRs: number | null; pnlPct: number | null; priceShown: number; stale: boolean } {
  const isActive = entry.exitPrice == null;
  const stale = entry.priceStale === true;
  const pnlPct = entry.pnlPct ?? null;
  const pnlRs = pnlPct == null ? null : (pnlPct / 100) * notional;
  const priceShown = isActive ? entry.currentPrice ?? 0 : entry.exitPrice ?? 0;
  return { pnlRs, pnlPct, priceShown, stale };
}
