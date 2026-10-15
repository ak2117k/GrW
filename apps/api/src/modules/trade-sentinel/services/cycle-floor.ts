import type { ExitDisciplineConfig } from '../../exit-discipline/config';
import { noiseAwareFloor } from '../../exit-discipline/floor';
import type { NoiseFloor } from '../../exit-discipline/types';
import { breakevenPrice, type Segment, type Side } from '../charges';

type Memory = { armed: boolean; level: number | null; entry: number | null };
const EMPTY: Memory = { armed: false, level: null, entry: null };

/**
 * The durable half of the noise-floor latch: an ARMED noise floor recorded in
 * the last live packet at the same entry price. A fixed-basis packet is no
 * evidence (the ₹150 latch never arms the noise floor), nor is garbage.
 */
export function storedNoiseFloor(last: { packet?: unknown } | undefined | null, entryPrice: number): { armed: boolean; level: number | null } {
  const p = last?.packet as { position?: { entryPrice?: unknown }; money?: { floorBasis?: unknown; greenFloorArmed?: unknown; greenFloorPrice?: unknown } } | undefined;
  if (!p || typeof p !== 'object' || p.money?.floorBasis !== 'noise' || p.position?.entryPrice !== entryPrice) return { armed: false, level: null };
  const level = typeof p.money.greenFloorPrice === 'number' && Number.isFinite(p.money.greenFloorPrice) ? p.money.greenFloorPrice : null;
  return p.money.greenFloorArmed === true ? { armed: true, level } : { armed: false, level: null };
}

/** The cycle's noise-floor ratchet (spec §4, plan R4): in-process memory + the last live packet. */
export function solveCycleFloor(i: {
  cfg: ExitDisciplineConfig; segment: Segment; side: Side; entryPrice: number; qty: number;
  holdingHigh: number | null; holdingLow: number | null; nContract: number | null;
  memory: Memory; last: { packet?: unknown } | undefined;
}): { noiseFloor: NoiseFloor | null; memory: Memory } {
  if (!i.cfg.enabled || i.nContract === null || !(i.nContract > 0)) return { noiseFloor: null, memory: EMPTY };
  const breakeven = breakevenPrice({ segment: i.segment, entryPrice: i.entryPrice, qty: i.qty, side: i.side });
  if (breakeven === null) return { noiseFloor: null, memory: EMPTY };
  const mem = i.memory.entry === i.entryPrice ? i.memory : EMPTY;
  const stored = storedNoiseFloor(i.last, i.entryPrice);
  const prevLevel = mem.level ?? stored.level;
  const nf = noiseAwareFloor({
    side: i.side, breakeven, peak: i.side === 'LONG' ? i.holdingHigh : i.holdingLow, n: i.nContract,
    armN: i.cfg.floorArmN, trailN: i.cfg.floorTrailN, prevArmedLevel: prevLevel, latchedArmed: mem.armed || stored.armed,
  });
  return { noiseFloor: nf, memory: nf.armed ? { armed: true, level: nf.level, entry: i.entryPrice } : { ...EMPTY, entry: i.entryPrice } };
}
