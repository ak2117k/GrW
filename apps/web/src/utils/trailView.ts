import type { WatchEntry } from '../types/watch.types';

/** Hard loss-cut price-fraction (R5 mirror): 0.4% of deployed capital. */
const HARD_STOP_PCT = 0.004;
/** Partial-exit arm threshold (mirror): +1% favorable from entry. */
const PARTIAL_EXIT_THRESHOLD_PCT = 0.01;
/** When the trail stop sits within this % of the current price, the SL cell is amber. */
export const SL_AMBER_THRESHOLD_PCT = 0.1;

export type TrailState = 'n/a' | 'pending' | 'armed';
export type SlKind = 'hard' | 'trail';

export interface TrailView {
  state: TrailState;
  /** SL column value; non-null only when the entry is currently TRADED (open). */
  slPrice: number | null;
  slKind: SlKind | null;
  /** pending only: the +1% favorable price at which the trail arms. */
  armPrice: number | null;
  // armed metrics — null when state !== 'armed':
  partialQty: number | null;
  partialExitPrice: number | null;
  remainingQty: number | null;
  highWater: number | null;
  trailStop: number | null;
  realised: number | null;
  protected: number | null;
  lockedTotal: number | null;
  /** % the current price sits beyond the trail stop (favorable); null without a current price. */
  distancePct: number | null;
}

const EMPTY: TrailView = {
  state: 'n/a',
  slPrice: null, slKind: null, armPrice: null,
  partialQty: null, partialExitPrice: null, remainingQty: null,
  highWater: null, trailStop: null,
  realised: null, protected: null, lockedTotal: null,
  distancePct: null,
};

/**
 * Map a watch entry to its live trail + SL state. Pure — single source of
 * truth for the watch table's SL column and the detail-panel
 * TrailingStopSection. Mirrors the backend's two-phase exit lifecycle
 * (R5 hard loss-cut while pre-trail, 0.5% trailing stop once partial-exited).
 */
export function trailView(entry: WatchEntry): TrailView {
  const exec = entry.executedPrice;
  if (exec == null || exec <= 0) return EMPTY;

  const sideMul = entry.side === 'BUY' ? 1 : -1;
  const isTradedOpen = entry.status === 'TRADED';
  const hasTrail = entry.partialExitedAt != null;

  // armed: trail metrics for any entry that had a partial exit (open OR closed).
  // slPrice is gated on isTradedOpen so closed entries show "—" in the SL column
  // while the panel section can still render the final/historical trail state.
  if (hasTrail) {
    const partialQty = entry.partialQty ?? 0;
    const partialExitPrice = entry.partialExitPrice ?? exec;
    const remainingQty = entry.remainingQty ?? 0;
    const highWater = entry.trailingHighWater ?? null;
    const trailStop = entry.trailingStopPrice ?? null;

    const realised = (partialExitPrice - exec) * sideMul * partialQty;
    const protectedPnl: number | null =
      trailStop != null ? (trailStop - exec) * sideMul * remainingQty : null;
    const lockedTotal = protectedPnl != null ? realised + protectedPnl : null;

    const curr = entry.currentPrice;
    const distancePct =
      curr != null && trailStop != null && trailStop > 0
        ? ((curr - trailStop) / trailStop) * sideMul * 100
        : null;

    return {
      state: 'armed',
      slPrice: isTradedOpen ? trailStop : null,
      slKind: isTradedOpen && trailStop != null ? 'trail' : null,
      armPrice: null,
      partialQty, partialExitPrice, remainingQty,
      highWater, trailStop,
      realised, protected: protectedPnl, lockedTotal,
      distancePct,
    };
  }

  // pending: open and not yet partial-exited — the R5 hard loss-cut is the active stop.
  if (isTradedOpen) {
    return {
      ...EMPTY,
      state: 'pending',
      slPrice: exec * (1 - HARD_STOP_PCT * sideMul),
      slKind: 'hard',
      armPrice: exec * (1 + PARTIAL_EXIT_THRESHOLD_PCT * sideMul),
    };
  }

  // executed but closed before the trail ever armed → n/a
  return EMPTY;
}
