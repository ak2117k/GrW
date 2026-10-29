import type { FloorAnchors, PriceAnchor } from '../../exit-discipline/types';
import type { Side } from '../charges';

/** In-process anchors, keyed to the entry they were taken against (a re-entry starts afresh). */
export type AnchorMemory = FloorAnchors & { entry: number | null };
export const EMPTY_ANCHORS: AnchorMemory = { best: null, floorArm: null, entry: null };

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function anchorOf(x: unknown): PriceAnchor | null {
  const a = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
  if (!a || !fin(a.ltp) || a.ltp <= 0 || typeof a.at !== 'string') return null;
  return { ltp: a.ltp, underlying: fin(a.underlying) ? a.underlying : null, at: a.at };
}

/**
 * The durable half of the anchors (the same rule as `storedNoiseFloor`): `money.anchors` of the last
 * live packet at the same entry price, so a restart neither forgets the best point nor re-anchors it
 * at whatever the underlying happens to be when the process comes back.
 */
export function storedAnchors(last: { packet?: unknown } | undefined | null, entryPrice: number): FloorAnchors {
  const p = last?.packet as { position?: { entryPrice?: unknown }; money?: { anchors?: { best?: unknown; floorArm?: unknown } } } | undefined;
  if (!p || typeof p !== 'object' || p.position?.entryPrice !== entryPrice || !p.money?.anchors) return { best: null, floorArm: null };
  return { best: anchorOf(p.money.anchors.best), floorArm: anchorOf(p.money.anchors.floorArm) };
}

/**
 * FLOOR_HARD_EXIT: the two FIXED references adverse moves are measured from, updated once per cycle
 * pass. Pure; the caller owns the memory.
 *
 *  - best: the position's best contract price (the trade tracker's holdingHigh for a long, holdingLow
 *    for a short) and the underlying at the pass that first saw it. Moves only to a BETTER price —
 *    never to a later verdict's, which is what let the 2026-10-29 grind re-anchor itself away. The
 *    underlying is read at the pass, so a peak printed between passes is paired with the next pass's
 *    underlying: slightly less favourable than at the print, i.e. it UNDER-states the adverse move.
 *  - floorArm: the contract price and underlying at the pass that first saw the green floor armed.
 *    Latched for the entry: a floor that briefly reads unarmed (N unmeasured) does not re-anchor it.
 */
export function solveCycleAnchors(i: {
  side: Side; entryPrice: number; ltp: number; peak: number | null; underlying: number | null;
  floorArmed: boolean; now: Date; memory: AnchorMemory; last: { packet?: unknown } | undefined;
}): { anchors: FloorAnchors; memory: AnchorMemory } {
  const base: AnchorMemory = i.memory.entry === i.entryPrice ? i.memory : { ...storedAnchors(i.last, i.entryPrice), entry: i.entryPrice };
  const dir = i.side === 'LONG' ? 1 : -1;
  const at = i.now.toISOString();
  const u = fin(i.underlying) ? i.underlying : null;
  const seen = [i.peak, i.ltp].filter((x): x is number => fin(x) && x > 0);
  const px = seen.length === 0 ? null : dir > 0 ? Math.max(...seen) : Math.min(...seen);
  const best = px !== null && (base.best === null || (px - base.best.ltp) * dir > 1e-9)
    ? { ltp: px, underlying: u, at }
    : base.best;
  const floorArm = base.floorArm ?? (i.floorArmed && fin(i.ltp) && i.ltp > 0 ? { ltp: i.ltp, underlying: u, at } : null);
  const anchors: FloorAnchors = { best, floorArm };
  return { anchors, memory: { ...anchors, entry: i.entryPrice } };
}
