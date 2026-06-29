export interface PartialLeg {
  entryPrice: number;
  exitPrice: number | null;
  partialExitPrice?: number | null;
  partialFraction?: number | null;
}

/** Realized % P&L, blending the booked partial leg with the final-exit leg. */
export function realizedIntradayPnlPct(e: PartialLeg): number | null {
  if (e.exitPrice == null || !(e.entryPrice > 0)) return null;
  const finalPct = ((e.exitPrice - e.entryPrice) / e.entryPrice) * 100;
  if (e.partialExitPrice != null && e.partialFraction != null && e.partialFraction > 0) {
    const partialPct = ((e.partialExitPrice - e.entryPrice) / e.entryPrice) * 100;
    return e.partialFraction * partialPct + (1 - e.partialFraction) * finalPct;
  }
  return finalPct;
}
