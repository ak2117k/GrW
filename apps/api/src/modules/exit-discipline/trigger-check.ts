import { INVALIDATION_SCALE_TOLERANCE } from './config';
import { exposureOf } from './exposure';
import { readPacketFacts } from './packet-facts';

/**
 * TRIGGER CHECK — RECORD ONLY (2026-11-10). Pure; never throws from `triggerCheckFromPacket`.
 *
 * What an AI exit price trigger looked like at the moment it was armed: how far from the price it sat in
 * noise units, whether it sat INSIDE the AI's own stated invalidation, and what it was for (cutting a loss
 * or protecting a profit). Nothing reads it to arm, fire or exit — it is stored on the trigger (real:
 * sentinel_exit_triggers.check, paper: paper_sentinel_looks.exitTrigger.check) and copied into the exit's
 * noise read, so later evidence (positionFollow) can say whether tight triggers inside the invalidation
 * cost money. Prior replays showed loosening exits can lose more, so this only records.
 *
 * Case 2026-11-10 (paper GOLD 141000 PE long): invalidation 141860, spot 141021, net −₹7.8k, trigger
 * UNDERLYING ABOVE 141150 — 129 pts ≈ 2.3 N, 700 pts inside the invalidation; fired 3 min later at the
 * hour's extreme.
 */

/** distanceN below this is "tight" (a couple of ordinary minutes' swing). */
export const TRIGGER_CHECK_TIGHT_N = 3;

export type TriggerCheckOp = 'ABOVE' | 'BELOW';
export type TriggerCheckInstrument = 'UNDERLYING' | 'PREMIUM';
/** The underlying direction that helps the position. */
export type PositionWant = 'UP' | 'DOWN';

export interface TriggerCheckInput {
  op: TriggerCheckOp;
  instrument: TriggerCheckInstrument;
  triggerPrice: number;
  /** The watched instrument's price when the trigger armed. */
  refPrice: number;
  /** One noise unit on the watched instrument's scale; null when unknown. */
  noiseUnit: number | null;
  noiseSource?: string | null;
  /** The stated thesis invalidation on the UNDERLYING scale; null when unknown. */
  invalidation: number | null;
  invalidationSource?: string | null;
  positionWant: PositionWant | null;
  netPnl: number | null;
  greenFloorArmed: boolean;
}

/** A `type` (not an interface) so it is assignable to Prisma JSON. */
export type TriggerCheck = {
  v: 1;
  op: TriggerCheckOp;
  instrument: TriggerCheckInstrument;
  triggerPrice: number;
  refPrice: number;
  /** triggerPrice − refPrice (signed). */
  distance: number;
  /** |distance| / noiseUnit; null without a unit. */
  distanceN: number | null;
  /** The trigger sits between the price and the invalidation, on the adverse side. null: PREMIUM, or no invalidation / direction. */
  insideInvalidation: boolean | null;
  invalidation: number | null;
  invalidationSource: string | null;
  noiseUnit: number | null;
  noiseSource: string | null;
  positionWant: PositionWant | null;
  netPnl: number | null;
  pnlState: 'GREEN' | 'RED' | 'FLAT';
  greenFloorArmed: boolean;
  purpose: 'PROTECT_PROFIT' | 'CUT_LOSS';
  tight: boolean;
};

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;

export function triggerCheck(i: TriggerCheckInput): TriggerCheck {
  const distance = r2(i.triggerPrice - i.refPrice);
  const unit = fin(i.noiseUnit) && i.noiseUnit > 0 ? i.noiseUnit : null;
  const distanceN = unit !== null ? r2(Math.abs(distance) / unit) : null;
  const inv = fin(i.invalidation) ? i.invalidation : null;

  let insideInvalidation: boolean | null = null;
  if (i.instrument === 'UNDERLYING' && inv !== null && i.positionWant) {
    // Adverse = the direction that hurts the position: UP for a position that wants DOWN.
    const adverseUp = i.positionWant === 'DOWN';
    const lo = adverseUp ? i.refPrice : inv;
    const hi = adverseUp ? inv : i.refPrice;
    insideInvalidation = lo < hi && i.triggerPrice > lo && i.triggerPrice < hi;
  }

  const net = fin(i.netPnl) ? i.netPnl : null;
  const pnlState = net === null || net === 0 ? 'FLAT' : net > 0 ? 'GREEN' : 'RED';
  return {
    v: 1,
    op: i.op,
    instrument: i.instrument,
    triggerPrice: i.triggerPrice,
    refPrice: i.refPrice,
    distance,
    distanceN,
    insideInvalidation,
    invalidation: inv,
    invalidationSource: inv !== null ? i.invalidationSource ?? null : null,
    noiseUnit: unit !== null ? r2(unit) : null,
    noiseSource: unit !== null ? i.noiseSource ?? null : null,
    positionWant: i.positionWant,
    netPnl: net,
    pnlState,
    greenFloorArmed: i.greenFloorArmed,
    purpose: (net !== null && net > 0) || i.greenFloorArmed ? 'PROTECT_PROFIT' : 'CUT_LOSS',
    tight: distanceN !== null && distanceN < TRIGGER_CHECK_TIGHT_N,
  };
}

const NUMBER = /\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * The first number in the AI's invalidationPoint text that is on the underlying's scale (within the
 * gate's INVALIDATION_SCALE_TOLERANCE of `near`), commas allowed ("141,860"). Times, minutes and noise-unit
 * counts ("15m close", "2 N") are off-scale and skipped. null: no text, no reference, or no such number.
 */
export function parseInvalidationText(text: string | null | undefined, near: number | null): number | null {
  if (typeof text !== 'string' || !fin(near) || near <= 0) return null;
  for (const m of text.matchAll(NUMBER)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (fin(n) && n > 0 && Math.abs(n - near) / near <= INVALIDATION_SCALE_TOLERANCE) return n;
  }
  return null;
}

/**
 * The check from what is stored at arming: the verdict's packet, its invalidationPoint text and net P&L.
 * Invalidation: the verdict's own invalidationPoint text first (what the AI stated for THIS verdict), else
 * the packet thesis's invalidation, each only on the underlying's scale. N: the packet's flow.noiseUnit on
 * the watched instrument's scale (underlying for UNDERLYING, contract for PREMIUM). Never throws: null
 * when the packet's position is unreadable or anything goes wrong.
 */
export function triggerCheckFromPacket(i: {
  op: TriggerCheckOp;
  instrument: TriggerCheckInstrument;
  triggerPrice: number;
  refPrice: number;
  packet: unknown;
  invalidationPoint: string | null | undefined;
  /** The verdict's net P&L column; the packet's money.netPnl when absent. */
  netPnl?: number | null;
}): TriggerCheck | null {
  try {
    const f = readPacketFacts(i.packet);
    if ('unreadable' in f) return null;
    // The underlying's scale: the watched price itself for an UNDERLYING trigger, else the packet's underlying.
    const near = i.instrument === 'UNDERLYING' ? i.refPrice : f.underlying;
    const fromText = parseInvalidationText(i.invalidationPoint, near);
    const fromThesis = fin(f.invalidation) && fin(near) && near > 0 && Math.abs(f.invalidation - near) / near <= INVALIDATION_SCALE_TOLERANCE
      ? f.invalidation : null;
    const invalidation = fromText ?? fromThesis;
    const reading = i.instrument === 'UNDERLYING' ? f.noise?.underlying : f.noise?.contract;
    const scale = i.instrument === 'UNDERLYING' ? 'underlying' : 'contract';
    return triggerCheck({
      op: i.op,
      instrument: i.instrument,
      triggerPrice: i.triggerPrice,
      refPrice: i.refPrice,
      noiseUnit: reading?.n ?? null,
      noiseSource: reading ? `packet.${scale}:${reading.method}` : null,
      invalidation,
      invalidationSource: fromText !== null ? 'VERDICT_TEXT' : fromThesis !== null ? 'PACKET_THESIS' : null,
      positionWant: exposureOf(f.symbol, f.side) === 'BULLISH' ? 'UP' : 'DOWN',
      netPnl: fin(i.netPnl) ? i.netPnl : f.netPnl,
      greenFloorArmed: f.floor.armed,
    });
  } catch {
    return null;
  }
}
