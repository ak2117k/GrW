import type { AnandEntry } from '../services/anand';

export interface OpenBookSummary {
  /** How many positions are currently open (status TRADED / exitPrice null). */
  openCount: number;
  /** Actual capital deployed: Σ floor(notional/entryPrice) × entryPrice. Always
   *  ≤ notional per position — whole shares only, the remainder stays as cash. */
  invested: number;
  /** Live mark-to-market value: Σ qty × currentPrice. A stale position (no live
   *  price) is held at cost (qty × entryPrice) so it adds 0 to unrealized. */
  currentValue: number;
  /** Unrealized P&L in rupees = currentValue − invested. */
  unrealizedRs: number;
}

/**
 * Summarise the open book — actual deployed capital and its live value.
 *
 * ₹200k is only the per-trade allocation ceiling; you can't buy a fractional
 * share, so the real invested amount is floor(notional/entryPrice) × entryPrice
 * (a bit under the notional, the rest left as cash). currentValue marks that
 * same share count at the live price. Takes no date argument by design, so the
 * figures reflect every open position regardless of when it was entered.
 */
export function summarizeOpenBook(openEntries: AnandEntry[], notional: number): OpenBookSummary {
  let invested = 0;
  let currentValue = 0;
  for (const e of openEntries) {
    const qty = e.entryPrice > 0 ? Math.floor(notional / e.entryPrice) : 0;
    invested += qty * e.entryPrice;
    // No live price → hold at cost so a stale position contributes 0 unrealized.
    const mark = e.currentPrice == null ? e.entryPrice : e.currentPrice;
    currentValue += qty * mark;
  }
  return {
    openCount: openEntries.length,
    invested,
    currentValue,
    unrealizedRs: currentValue - invested,
  };
}
