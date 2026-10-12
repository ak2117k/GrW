import type { OrderSide } from '../execution/execution.types';
import type { TrailBlock } from '../strategies/blocks/block-types';
import { round2 } from './exit-plan';
import type { ExitPlan } from './lifecycle.types';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Spec §7.4, the tighten-only invariant: a new stop is accepted only if it is closer to
 * the price (higher for a long, lower for a short). The first stop is accepted. Nothing
 * else in the core writes a stop after it is armed; SP3/SP4 guard rails go through this.
 */
export function tightenStop(current: number | null, proposed: number, side: OrderSide): { accepted: boolean; stop: number | null } {
  if (!finite(proposed) || proposed <= 0) return { accepted: false, stop: current };
  if (current === null) return { accepted: true, stop: proposed };
  const closer = side === 'BUY' ? proposed > current : proposed < current;
  return closer ? { accepted: true, stop: proposed } : { accepted: false, stop: current };
}

/** The ATR give-back from the extreme (silo resolveTrail): multiple × ATR within [minPct, maxPct] of the extreme. */
export function trailDistance(trail: Extract<TrailBlock, { kind: 'atr' }>, extreme: number, atr: number | null): number {
  const min = (trail.minPct / 100) * extreme;
  const max = (trail.maxPct / 100) * extreme;
  const dist = finite(atr) && atr > 0 ? trail.multiple * atr : 0;
  if (!(dist > 0) || dist < min) return min;
  return dist > max ? max : dist;
}

export interface MarkInput {
  side: OrderSide;
  plan: ExitPlan;
  entryAvgPrice: number;
  stopPrice: number | null;
  trailActive: boolean;
  partialDone: boolean;
  highWater: number | null;
  lowWater: number | null;
}

export interface Marks {
  highWater: number;
  lowWater: number;
  stopPrice: number | null;
  trailActive: boolean;
  /** Why the stop moved on this price, or null. */
  stopMoved: 'BREAKEVEN' | 'TRAIL' | null;
}

/** One fresh price: water marks, then the trail's candidate stop through tightenStop (ruling L5). */
export function advanceMarks(m: MarkInput, ltp: number): Marks {
  const highWater = Math.max(m.highWater ?? ltp, ltp);
  const lowWater = Math.min(m.lowWater ?? ltp, ltp);
  const buy = m.side === 'BUY';
  const extreme = buy ? highWater : lowWater;
  const trail = m.plan.trail;
  let stopPrice = m.stopPrice;
  let trailActive = m.trailActive;
  let stopMoved: Marks['stopMoved'] = null;
  if (trail.kind === 'breakeven') {
    const movePct = ((extreme - m.entryAvgPrice) / m.entryAvgPrice) * 100 * (buy ? 1 : -1);
    if (movePct >= trail.atPct) {
      const t = tightenStop(stopPrice, round2(m.entryAvgPrice), m.side);
      if (t.accepted) {
        stopPrice = t.stop;
        stopMoved = 'BREAKEVEN';
      }
    }
  } else if (trail.kind === 'atr') {
    if (!trailActive && (trail.startsAfter === 'ENTRY' || m.partialDone)) trailActive = true;
    if (trailActive) {
      const d = trailDistance(trail, extreme, m.plan.atr);
      const t = tightenStop(stopPrice, round2(buy ? extreme - d : extreme + d), m.side);
      if (t.accepted) {
        stopPrice = t.stop;
        stopMoved = 'TRAIL';
      }
    }
  }
  return { highWater, lowWater, stopPrice, trailActive, stopMoved };
}

/**
 * Parent §7.3: a hit target may become a trailing stop only after the stop has moved to
 * lock in at least the target's profit. No block uses it yet (drift D15); SP3/SP4 will.
 */
export function canConvertTargetToTrail(p: { side: OrderSide; stopPrice: number | null; targetPrice: number | null }): boolean {
  if (p.stopPrice === null || p.targetPrice === null) return false;
  return p.side === 'BUY' ? p.stopPrice >= p.targetPrice : p.stopPrice <= p.targetPrice;
}
