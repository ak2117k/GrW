import type { Segment, Side } from '../charges';
import type { TickSnapshot } from './context-packet.service';

/** The tick fields a seed needs (a TickReading satisfies it). */
export type SeedTick = Pick<
  TickSnapshot,
  'segment' | 'side' | 'entryPrice' | 'ltp' | 'underlyingLtp' | 'nearestSupport' | 'nearestResistance'
  | 'holdingHigh' | 'holdingLow' | 'contractRef' | 'underlyingRef'
>;

/**
 * Part B (price-triggers plan R14). What the price-only sensors need between two
 * 30-second passes, per tracker, keyed by the instruments whose ticks move them.
 * Filled by the cycle after every tick read; read by TickTripwireService on hub
 * ticks. Pure in-memory: no I/O, no imports beyond types.
 */
export interface TickSensorContext {
  userId: string;
  trackerId: string;
  symbol: string;
  segment: Segment;
  side: Side;
  entryPrice: number;
  contractKey: string;
  underlyingKey: string | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
  holdingHigh: number | null;
  holdingLow: number | null;
  ltp: number;
  underlyingLtp: number | null;
  /** Tick bookkeeping, preserved across upserts. */
  lastEvalAt: number;
  firing: boolean;
}

export type SensorSeed = Omit<TickSensorContext, 'lastEvalAt' | 'firing'>;

const EMPTY: TickSensorContext[] = [];

export function keyOf(r: { exchange: string; token: string }): string {
  return `${String(r.exchange ?? '').toUpperCase()}:${r.token}`;
}

export function sensorSeed(entry: { userId: string; trackerId: string; symbol: string }, tick: SeedTick): SensorSeed | null {
  if (!tick.contractRef) return null;
  const contractKey = keyOf(tick.contractRef);
  const isCash = tick.segment === 'EQ_DELIVERY' || tick.segment === 'EQ_INTRADAY';
  return {
    userId: entry.userId, trackerId: entry.trackerId, symbol: entry.symbol,
    segment: tick.segment, side: tick.side, entryPrice: tick.entryPrice,
    contractKey,
    underlyingKey: isCash ? contractKey : tick.underlyingRef ? keyOf(tick.underlyingRef) : null,
    nearestSupport: tick.nearestSupport, nearestResistance: tick.nearestResistance,
    holdingHigh: tick.holdingHigh, holdingLow: tick.holdingLow,
    ltp: tick.ltp, underlyingLtp: tick.underlyingLtp,
  };
}

export class TickSensorBook {
  private readonly byTracker = new Map<string, TickSensorContext>();
  private readonly byKey = new Map<string, Set<string>>();

  upsert(seed: SensorSeed): void {
    const prev = this.byTracker.get(seed.trackerId);
    if (prev) this.unindex(prev);
    const next: TickSensorContext = { ...seed, lastEvalAt: prev?.lastEvalAt ?? 0, firing: prev?.firing ?? false };
    this.byTracker.set(seed.trackerId, next);
    this.index(next.contractKey, next.trackerId);
    if (next.underlyingKey && next.underlyingKey !== next.contractKey) this.index(next.underlyingKey, next.trackerId);
  }

  prune(userId: string, live: Set<string>): void {
    for (const c of [...this.byTracker.values()]) {
      if (c.userId === userId && !live.has(c.trackerId)) {
        this.unindex(c);
        this.byTracker.delete(c.trackerId);
      }
    }
  }

  forKey(key: string): TickSensorContext[] {
    const ids = this.byKey.get(key);
    if (!ids) return EMPTY;
    const out: TickSensorContext[] = [];
    for (const id of ids) {
      const c = this.byTracker.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  users(): string[] {
    return [...new Set([...this.byTracker.values()].map((c) => c.userId))];
  }

  size(): number {
    return this.byTracker.size;
  }

  private index(key: string, id: string): void {
    let s = this.byKey.get(key);
    if (!s) {
      s = new Set();
      this.byKey.set(key, s);
    }
    s.add(id);
  }

  private unindex(c: TickSensorContext): void {
    for (const key of [c.contractKey, c.underlyingKey]) {
      if (!key) continue;
      const s = this.byKey.get(key);
      s?.delete(c.trackerId);
      if (s && s.size === 0) this.byKey.delete(key);
    }
  }
}
