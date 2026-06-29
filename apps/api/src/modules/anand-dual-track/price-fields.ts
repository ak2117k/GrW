export interface PriceFields {
  /** Resolved live/seed price, or null when no price could be found anywhere. */
  currentPrice: number | null;
  /** Mark-to-market % vs entry, or null when the price is unavailable. */
  pnlPct: number | null;
  /** Remaining % to target, or null when the price is unavailable. */
  targetLeftPct: number | null;
  /** True when neither the live LTP batch nor the level-book seed had a price. */
  priceStale: boolean;
}

export interface PriceableEntry {
  token: string | null;
  entryPrice: number;
  targetPct: number;
}

/**
 * Resolve the display price + P&L for an open position, honest about gaps.
 *
 * Priority: live LTP batch -> level-book seed -> stale. We deliberately do NOT
 * fall back to entryPrice (the old bug): substituting entryPrice renders a data
 * gap as a real "0% / no movement" price, indistinguishable from a flat
 * position. When no price exists anywhere, every numeric field is null and
 * priceStale is true so the UI can show "—" instead of a fabricated number.
 */
export function resolvePriceFields(
  entry: PriceableEntry,
  ltpMap: Map<string, number>,
  seedMap: Map<string, number>,
): PriceFields {
  const price =
    (entry.token ? ltpMap.get(entry.token) ?? seedMap.get(entry.token) : undefined) ?? null;
  if (price == null) {
    return { currentPrice: null, pnlPct: null, targetLeftPct: null, priceStale: true };
  }
  const pnlPct = ((price - entry.entryPrice) / entry.entryPrice) * 100;
  return { currentPrice: price, pnlPct, targetLeftPct: entry.targetPct - pnlPct, priceStale: false };
}
