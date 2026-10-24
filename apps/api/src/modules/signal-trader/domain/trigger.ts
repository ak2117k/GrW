import { entryBand, type TriggerState } from './gate';
import type { SignalView } from './signal.types';

/**
 * Pending triggers for "BUY ABOVE x / SELL BELOW x" (owner-approved 2026-10-24). Pure.
 *
 * A signal that passes every gate check except "the price has not reached x yet" is not SKIPped:
 * the decision stays PENDING and the contract's LTP is watched (≤ every SIGNAL_TRIGGER_POLL_SEC,
 * ≥ 5 s, at most SIGNAL_TRIGGER_MAX_PENDING ≤ 5 at once) for up to SIGNAL_TRIGGER_WAIT_MIN, never past
 * the min-minutes-to-close cutoff. When LTP is inside the no-chase band ([x, x·1.03] for ABOVE) the
 * full gate runs again (caps, funds, kill switch…) before anything is placed.
 */

/** Only an explicit ABOVE / BELOW entry waits; AT / RANGE entries never do. */
export function triggerOp(s: Pick<SignalView, 'entryType'>): 'ABOVE' | 'BELOW' | null {
  return s.entryType === 'ABOVE' || s.entryType === 'BELOW' ? s.entryType : null;
}

/** LTP has not reached the trigger yet (ABOVE: below the band; BELOW: above it). */
export function entryNotReached(s: Pick<SignalView, 'entryType' | 'entryLow' | 'entryHigh'>, ltp: number | null, tolPct: number): boolean {
  const op = triggerOp(s);
  if (!op || ltp === null || !(ltp > 0)) return false;
  const band = entryBand(s, tolPct);
  return op === 'ABOVE' ? ltp < band.low - 1e-9 : ltp > band.high + 1e-9;
}

/** The trigger price and its no-chase band. */
export function triggerOf(s: Pick<SignalView, 'entryType' | 'entryLow' | 'entryHigh'>, tolPct: number): { price: number; op: 'ABOVE' | 'BELOW'; bandLow: number; bandHigh: number } | null {
  const op = triggerOp(s);
  if (!op) return null;
  const band = entryBand(s, tolPct);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { op, price: op === 'ABOVE' ? band.low : band.high, bandLow: r2(band.low), bandHigh: r2(band.high) };
}

/**
 * When an armed trigger expires: armedAt + waitMin, but never later than the moment only
 * `minMinutesToClose` remain in the session. null = no time left to wait at all.
 */
export function triggerExpiry(armedAt: Date, waitMin: number, minutesToClose: number | null, minMinutesToClose: number): Date | null {
  if (!(waitMin > 0)) return null;
  let end = armedAt.getTime() + waitMin * 60_000;
  if (minutesToClose !== null && Number.isFinite(minutesToClose)) {
    end = Math.min(end, armedAt.getTime() + (minutesToClose - minMinutesToClose) * 60_000);
  }
  return end > armedAt.getTime() ? new Date(end) : null;
}

/** Is LTP inside the trigger's no-chase band? */
export function triggerHit(t: Pick<TriggerState, 'bandLow' | 'bandHigh'>, ltp: number | null): boolean {
  return ltp !== null && ltp > 0 && ltp >= t.bandLow - 1e-9 && ltp <= t.bandHigh + 1e-9;
}

/** Is a judge verdict given at `judgedAt` still fresh enough to reuse at `now`? */
export function judgeFresh(judgedAt: string | null | undefined, now: Date, reuseMin: number): boolean {
  if (!judgedAt) return false;
  const t = Date.parse(judgedAt);
  return Number.isFinite(t) && now.getTime() - t <= reuseMin * 60_000;
}

/** Read a TriggerState back from SignalDecision.plan JSON (restart-safe); null when malformed. */
export function readTrigger(plan: unknown): TriggerState | null {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const t = (plan as Record<string, unknown>).trigger as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const price = n(t.price);
  const lo = n(t.bandLow);
  const hi = n(t.bandHigh);
  const op = t.op === 'ABOVE' || t.op === 'BELOW' ? t.op : null;
  const armedAt = typeof t.armedAt === 'string' ? t.armedAt : null;
  const expiresAt = typeof t.expiresAt === 'string' ? t.expiresAt : null;
  if (price === null || lo === null || hi === null || !op || !armedAt || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  return {
    price,
    op,
    bandLow: lo,
    bandHigh: hi,
    armedAt,
    expiresAt,
    judgedAt: typeof t.judgedAt === 'string' ? t.judgedAt : null,
    lastLtp: n(t.lastLtp),
    lastCheckAt: typeof t.lastCheckAt === 'string' ? t.lastCheckAt : null,
  };
}
