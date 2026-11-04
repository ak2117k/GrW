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

/** Conservative option delta for the stand-in noise unit: ATM-ish, so an OTM contract's unit is OVER-stated (arms later, never sooner). */
export const STAND_IN_OPTION_DELTA = 0.5;

/**
 * The noise unit the floor arms and trails by. Prod 2026-11-04 18:05–18:08 IST: a paper CRUDEOIL 8600 PE
 * (qty 100) was exited 2 m 23 s after entry by FLOOR_HARD_GREEN_TO_RED. Its contract noise unit was not
 * measured yet ("N ?"), so the floor fell back to the FIXED ₹150 basis — 1.5 premium points — armed on one
 * tick of wobble and sold at breakeven; the PE reached its 339 target by 21:00. Until the contract's own
 * unit exists, stand in the UNDERLYING's 1-minute unit × a conservative delta (0.5 for CE/PE, 1 otherwise),
 * so the floor never arms on a 1.5-point blip. Null only when neither unit is known (the fixed basis then).
 */
export function floorNoiseUnit(contractN: number | null | undefined, underlyingN: number | null | undefined, symbol: string): { n: number | null; source: 'contract' | 'underlying-stand-in' | 'none' } {
  if (typeof contractN === 'number' && contractN > 0) return { n: contractN, source: 'contract' };
  if (typeof underlyingN === 'number' && underlyingN > 0) {
    const delta = /(CE|PE)$/i.test(String(symbol).trim()) ? STAND_IN_OPTION_DELTA : 1;
    return { n: Math.round(underlyingN * delta * 100) / 100, source: 'underlying-stand-in' };
  }
  return { n: null, source: 'none' };
}

/** The cycle's noise-floor ratchet (spec §4, plan R4): in-process memory + the last live packet. */
export function solveCycleFloor(i: {
  cfg: ExitDisciplineConfig; segment: Segment; side: Side; entryPrice: number; qty: number;
  holdingHigh: number | null; holdingLow: number | null; nContract: number | null;
  memory: Memory; last: { packet?: unknown } | undefined;
  /** SPIKE BANK (cycle-spike.ts): the trail in force for this position; absent ⇒ cfg.floorTrailN. */
  trailN?: number;
  /** MCX rupee factor (contractValueFactor); absent ⇒ 1. */
  valueFactor?: number;
}): { noiseFloor: NoiseFloor | null; memory: Memory } {
  if (!i.cfg.enabled || i.nContract === null || !(i.nContract > 0)) return { noiseFloor: null, memory: EMPTY };
  const breakeven = breakevenPrice({ segment: i.segment, entryPrice: i.entryPrice, qty: i.qty, side: i.side, valueFactor: i.valueFactor });
  if (breakeven === null) return { noiseFloor: null, memory: EMPTY };
  const mem = i.memory.entry === i.entryPrice ? i.memory : EMPTY;
  const stored = storedNoiseFloor(i.last, i.entryPrice);
  const prevLevel = mem.level ?? stored.level;
  const nf = noiseAwareFloor({
    side: i.side, breakeven, peak: i.side === 'LONG' ? i.holdingHigh : i.holdingLow, n: i.nContract,
    armN: i.cfg.floorArmN, trailN: typeof i.trailN === 'number' && i.trailN > 0 ? i.trailN : i.cfg.floorTrailN, prevArmedLevel: prevLevel, latchedArmed: mem.armed || stored.armed,
  });
  return { noiseFloor: nf, memory: nf.armed ? { armed: true, level: nf.level, entry: i.entryPrice } : { ...EMPTY, entry: i.entryPrice } };
}
