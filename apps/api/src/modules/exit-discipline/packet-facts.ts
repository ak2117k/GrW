import type { FloorBasis, NoiseUnitValue, PositionSide } from './types';

/** What the gate and the replay read from a stored `sentinel_verdicts.packet`. Defensive: the packet is JSON from the DB. */
export interface PacketFacts {
  symbol: string; side: PositionSide; qty: number; entryPrice: number; ltp: number;
  underlying: number | null; invalidation: number | null; vwap: number | null; levelBookAtr15m: number | null;
  noise: NoiseUnitValue | null;
  floor: { price: number | null; armed: boolean; basis: FloorBasis };
  netPnl: number | null; charges: number | null; expiry: string | null; builtAt: string | null;
  minutesToClose: number | null; support: number | null; resistance: number | null;
  /** `money.anchors` (FLOOR_HARD_EXIT): the underlying at the best point and at the floor's arm point. Absent key ⇒ a pre-anchor packet. */
  anchors?: { bestUnderlying: number | null; armUnderlying: number | null };
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
/** A packet Block: its value when `available === true`, else null. */
const blockValue = (x: unknown): unknown => { const b = obj(x); return b && b.available === true ? b.value : null; };

function noiseReading(x: unknown) {
  const r = obj(x);
  const n = num(r?.n);
  return r && n !== null && n > 0 ? { n, method: String(r.method) as never, bars: num(r.bars) ?? 0, at: String(r.at ?? '') } : null;
}

export function readPacketFacts(packet: unknown): PacketFacts | { unreadable: string } {
  const p = obj(packet);
  const pos = obj(p?.position);
  const money = obj(p?.money);
  if (!p || !pos) return { unreadable: 'packet has no position' };
  if (!money) return { unreadable: 'packet has no money block' };
  const side = pos.side === 'LONG' || pos.side === 'SHORT' ? (pos.side as PositionSide) : null;
  const qty = num(pos.qty), entryPrice = num(pos.entryPrice), ltp = num(pos.ltp);
  if (!side || qty === null || entryPrice === null || ltp === null) return { unreadable: 'position side/qty/entryPrice/ltp not readable' };

  const structure = obj(p.structure);
  const book = obj(blockValue(structure?.levelBook));
  const thesis = obj(blockValue(p.thesis));
  const flow = obj(p.flow);
  const noiseRaw = obj(blockValue(flow?.noiseUnit));
  const noise = noiseRaw ? { contract: noiseReading(noiseRaw.contract), underlying: noiseReading(noiseRaw.underlying) } : null;
  const session = obj(p.session);
  const anchors = obj(money.anchors);

  return {
    symbol: String(pos.symbol ?? ''), side, qty, entryPrice, ltp,
    underlying: num(blockValue(pos.underlyingLtp)),
    invalidation: num(thesis?.invalidation),
    vwap: num(book?.vwap),
    levelBookAtr15m: num(book?.atr14),
    noise: noise && (noise.contract || noise.underlying) ? noise : null,
    floor: { price: num(money.greenFloorPrice), armed: money.greenFloorArmed === true, basis: money.floorBasis === 'noise' ? 'noise' : 'fixed' },
    netPnl: num(money.netPnl), charges: num(money.charges),
    expiry: str(pos.expiry), builtAt: str(session?.nowUtc),
    minutesToClose: num(blockValue(session?.minutesToClose)),
    support: num(blockValue(structure?.nearestSupport)),
    resistance: num(blockValue(structure?.nearestResistance)),
    // Spread only when the packet carries the block, so a pre-anchor packet reads exactly as before.
    ...(anchors
      ? { anchors: { bestUnderlying: num(obj(anchors.best)?.underlying), armUnderlying: num(obj(anchors.floorArm)?.underlying) } }
      : {}),
  };
}
