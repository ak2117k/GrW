import type { SignalView } from './signal.types';

/** Pays when the UNDERLYING rises (BUY CE / SELL PE / BUY FUT / BUY EQ). Same rule as engine-sl, which imports gate. */
const longUnderlying = (kind: SignalView['instrumentKind'], side: 'BUY' | 'SELL') => (kind === 'PE' ? side === 'SELL' : side === 'BUY');

/**
 * Late entries (owner 2026-10-27). Pure.
 *
 * A call whose price has already run past the channel's entry band — BUY above it, SELL below it —
 * used to be a hard "chasing" SKIP before any plan existed, so the judge never saw it and paper never
 * learnt whether it would have worked. Now the entry is planned at the CURRENT price and the judge
 * decides on the room left: how far the underlying is from its next resistance / call wall (support /
 * put wall for a short), what that is worth in premium, against the stop from here. A move more than
 * SIGNAL_LATE_MAX_PCT past the entry is still refused: it is done, or the contract was mistyped.
 */

export interface LateEntry {
  /** The channel's entry (the band edge we are already past). */
  channelEntry: number;
  ltp: number;
  /** How far past the channel's entry, % of it (always ≥ 0). */
  chasePct: number;
  /** The channel's targets the price has already passed. */
  targetsPassed: number[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The price is past the band on the trade's side (BUY above it, SELL below it); null otherwise. */
export function lateEntryOf(
  s: Pick<SignalView, 'side' | 'targets' | 'entryLow' | 'entryHigh'>,
  ltp: number,
  band: { low: number; high: number },
): LateEntry | null {
  if (!(ltp > 0)) return null;
  // Measured from the CHANNEL's price (the top of its range for a buy), not from our tolerance edge.
  const edge = s.side === 'BUY' ? Math.max(s.entryLow, s.entryHigh) : Math.min(s.entryLow, s.entryHigh);
  const past = s.side === 'BUY' ? ltp > band.high + 1e-9 : ltp < band.low - 1e-9;
  if (!past || !(edge > 0)) return null;
  const targets = s.targets.filter((t) => Number.isFinite(t) && t > 0);
  return {
    channelEntry: r2(edge),
    ltp,
    chasePct: r2((Math.abs(ltp - edge) / edge) * 100),
    targetsPassed: targets.filter((t) => (s.side === 'BUY' ? t <= ltp : t >= ltp)),
  };
}

/** The band a late entry may fill in: from the current price, no further than the tolerance. */
export function lateBand(side: 'BUY' | 'SELL', ltp: number, tolPct: number): { low: number; high: number } {
  const t = tolPct / 100;
  return side === 'BUY' ? { low: ltp, high: ltp * (1 + t) } : { low: ltp * (1 - t), high: ltp };
}

/** The channel's targets still ahead of the current price. */
export function targetsAhead(side: 'BUY' | 'SELL', ltp: number, targets: readonly number[]): number[] {
  return targets.filter((t) => Number.isFinite(t) && t > 0 && (side === 'BUY' ? t > ltp : t < ltp));
}

export interface LateRoomInput {
  kind: SignalView['instrumentKind'];
  side: 'BUY' | 'SELL';
  /** The contract's price now (premium for an option). */
  ltp: number;
  sl: number;
  targets: readonly number[];
  /** Underlying price; for EQ / a future it is the contract itself. */
  spot: number | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
  callWall: number | null;
  putWall: number | null;
  /** Option delta (sign ignored); null = unknown. */
  delta: number | null;
}

export interface LateRoom {
  /** Which way the underlying has to go for the trade to pay. */
  needs: 'UP' | 'DOWN';
  spot: number | null;
  /** The first obstacle in that direction, and where it came from. */
  obstacle: { price: number; source: 'level book' | 'call wall' | 'put wall' } | null;
  /** Underlying points (and % of spot) to the obstacle. */
  roomPoints: number | null;
  roomPct: number | null;
  /** The contract's move to the obstacle: premium ≈ |delta| × points for an option, the points for EQ / FUT. */
  contractRoom: number | null;
  /** Contract points from here to the stop. */
  risk: number;
  /** contractRoom / risk; null when the room is unknown. */
  roomToRisk: number | null;
  /** The nearest channel target still ahead, and the contract points to it. */
  nextTarget: number | null;
  toNextTarget: number | null;
  /** What could not be read — stated, never treated as "no room". */
  missing: string[];
}

/** The room left for a late entry, from the level book and the chain walls. Never throws. */
export function lateRoom(i: LateRoomInput): LateRoom {
  const up = longUnderlying(i.kind, i.side);
  const option = i.kind === 'CE' || i.kind === 'PE';
  const missing: string[] = [];
  const spot = i.spot !== null && i.spot > 0 ? i.spot : null;
  if (spot === null) missing.push('underlying price');

  let obstacle: LateRoom['obstacle'] = null;
  if (spot !== null) {
    const cands: Array<{ price: number; source: 'level book' | 'call wall' | 'put wall' }> = [];
    const lvl = up ? i.nearestResistance : i.nearestSupport;
    const wall = up ? i.callWall : i.putWall;
    if (lvl !== null && lvl > 0) cands.push({ price: lvl, source: 'level book' });
    if (wall !== null && wall > 0) cands.push({ price: wall, source: up ? 'call wall' : 'put wall' });
    if (lvl === null) missing.push(`level book ${up ? 'resistance' : 'support'}`);
    if (wall === null && option) missing.push(`chain ${up ? 'call' : 'put'} wall`);
    const ahead = cands.filter((c) => (up ? c.price > spot : c.price < spot));
    if (ahead.length > 0) obstacle = ahead.reduce((a, b) => (Math.abs(b.price - spot) < Math.abs(a.price - spot) ? b : a));
  }

  const roomPoints = obstacle && spot !== null ? r2(Math.abs(obstacle.price - spot)) : null;
  const delta = i.delta !== null && Number.isFinite(i.delta) ? Math.abs(i.delta) : null;
  if (option && delta === null && roomPoints !== null) missing.push('option delta');
  const contractRoom = roomPoints === null ? null : option ? (delta !== null ? r2(roomPoints * delta) : null) : roomPoints;
  const risk = r2(Math.abs(i.ltp - i.sl));
  const ahead = targetsAhead(i.side, i.ltp, i.targets);
  const nextTarget = ahead.length > 0 ? (i.side === 'BUY' ? Math.min(...ahead) : Math.max(...ahead)) : null;
  return {
    needs: up ? 'UP' : 'DOWN',
    spot,
    obstacle,
    roomPoints,
    roomPct: roomPoints !== null && spot !== null ? r2((roomPoints / spot) * 100) : null,
    contractRoom,
    risk,
    roomToRisk: contractRoom !== null && risk > 0 ? r2(contractRoom / risk) : null,
    nextTarget,
    toNextTarget: nextTarget !== null ? r2(Math.abs(nextTarget - i.ltp)) : null,
    missing,
  };
}
