/**
 * Level-break log (research instrumentation, NOT a signal). PURE: bars in, breaks / outcomes out.
 *
 * Why: the NIFTY OI-pattern spike (grw-mbm research/oi-pattern, 2026-10-23) found ONE thing worth
 * re-testing on unseen data in 3–6 months: a 15-min level break during which front-month futures OI
 * rises tended to run further. It is explicitly NOT to be used as a filter in trading, auto-trade or
 * the sentinel. This module only records each break the app's own zone detector sees, the futures
 * OI around it, and the follow-through later — nothing here is read by any trading path.
 *
 * Break definition follows the level-break study: the bar CLOSES at least 0.3 × ATR beyond the
 * zone's far edge, and the previous bar closed on the near side of that edge (first break only).
 */

export const BREAK_CLOSE_ATR = 0.3;
export const ATR_PERIOD = 14;
const IST_OFFSET_MS = 330 * 60_000;
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;

export interface Bar {
  /** Bar START, epoch ms UTC. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TfBar extends Bar {
  /** Bar END (exclusive), epoch ms UTC. A session's last 60m bar ends at 15:30 IST. */
  end: number;
}

export interface ZoneLike {
  type: 'support' | 'resistance';
  upper: number;
  lower: number;
  classification: string;
  touchCount: number;
}

export type BreakDirection = 'UP' | 'DOWN';

export interface DetectedBreak {
  direction: BreakDirection;
  /** The broken edge: a resistance's upper / a support's lower. */
  level: number;
  zone: ZoneLike;
  /** Break bar END (the moment the break is known). */
  ts: number;
  price: number;
  atr: number;
}

export const istDay = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
export const istMinute = (ms: number): number => {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
/** Epoch ms of `minute` (IST minute-of-day) on the IST day containing `ms`. */
export const istAt = (ms: number, minute: number): number =>
  Date.parse(`${istDay(ms)}T00:00:00Z`) - IST_OFFSET_MS + minute * 60_000;

/**
 * 1-minute bars → session-aligned `tfMin` bars (buckets from 09:15 IST; the last bucket of a
 * session is clipped at 15:30). Only buckets that have ENDED by `now` are returned; bars outside
 * the session are ignored. Input order does not matter; output is oldest first.
 */
export function aggregateBars(bars1m: readonly Bar[], tfMin: number, now: number): TfBar[] {
  const buckets = new Map<number, TfBar>();
  const sorted = [...bars1m].filter((b) => [b.open, b.high, b.low, b.close].every(Number.isFinite)).sort((a, b) => a.ts - b.ts);
  for (const b of sorted) {
    const m = istMinute(b.ts);
    if (m < SESSION_OPEN_MIN || m >= SESSION_CLOSE_MIN) continue;
    const startMin = SESSION_OPEN_MIN + Math.floor((m - SESSION_OPEN_MIN) / tfMin) * tfMin;
    const start = istAt(b.ts, startMin);
    const end = istAt(b.ts, Math.min(startMin + tfMin, SESSION_CLOSE_MIN));
    const cur = buckets.get(start);
    if (!cur) buckets.set(start, { ts: start, end, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 });
    else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume ?? 0;
    }
  }
  return [...buckets.values()].filter((b) => b.end <= now).sort((a, b) => a.ts - b.ts);
}

/** Simple ATR(14) (mean true range of the last 14 bars); null with too few bars. */
export function atr14(bars: readonly Bar[], period = ATR_PERIOD): number | null {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    sum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  }
  const v = sum / period;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Breaks on `bar` of zones that existed before it (detected on the history up to `prev`).
 * Resistance: close ≥ upper + 0.3·ATR and prev.close ≤ upper. Support mirrored on `lower`.
 */
export function detectBreaks(zones: readonly ZoneLike[], prev: TfBar, bar: TfBar, atr: number): DetectedBreak[] {
  if (!(atr > 0)) return [];
  const out: DetectedBreak[] = [];
  const seen = new Set<string>();
  for (const z of zones) {
    let hit: DetectedBreak | null = null;
    if (z.type === 'resistance' && bar.close >= z.upper + BREAK_CLOSE_ATR * atr && prev.close <= z.upper) {
      hit = { direction: 'UP', level: z.upper, zone: z, ts: bar.end, price: bar.close, atr };
    } else if (z.type === 'support' && bar.close <= z.lower - BREAK_CLOSE_ATR * atr && prev.close >= z.lower) {
      hit = { direction: 'DOWN', level: z.lower, zone: z, ts: bar.end, price: bar.close, atr };
    }
    if (hit) {
      const key = `${hit.direction}:${hit.level}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(hit);
      }
    }
  }
  return out;
}

export interface OiPoint {
  ts: number; // 5-min bar START
  oi: number;
}

/**
 * Futures OI at the break (the 5-min OI bar that ENDS at or before `t`) and 15 min earlier.
 * Null fields when the series does not cover that moment yet.
 */
export function oiAround(points: readonly OiPoint[], t: number): { now: number | null; before15m: number | null; nowAt: number | null } {
  const at = (cut: number) => {
    let best: OiPoint | null = null;
    for (const p of points) if (p.ts + 5 * 60_000 <= cut && (!best || p.ts > best.ts)) best = p;
    // Stale beyond 15 min is not "the OI at this moment".
    return best && cut - (best.ts + 5 * 60_000) <= 15 * 60_000 ? best : null;
  };
  const n = at(t);
  const b = at(t - 15 * 60_000);
  return { now: n?.oi ?? null, before15m: b?.oi ?? null, nowAt: n ? n.ts : null };
}

export interface BreakOutcome {
  priceAt15m: number | null;
  priceAt60m: number | null;
  priceEod: number | null;
  /** Signed in the break direction (positive = followed through), points. */
  move15mPts: number | null;
  move60mPts: number | null;
  moveEodPts: number | null;
  /** Best / worst excursion in the break direction from the break close to the session close, points. */
  mfeEodPts: number | null;
  maeEodPts: number | null;
  /** The session's bars are complete — the row can be closed. */
  complete: boolean;
}

/**
 * Follow-through from the break close using the day's 1-minute bars. A horizon that falls past the
 * session close uses the session close. `complete` once the session's last bar (15:29) is present.
 */
export function breakOutcome(brk: { ts: number; price: number; direction: BreakDirection }, dayBars: readonly Bar[]): BreakOutcome {
  const sgn = brk.direction === 'UP' ? 1 : -1;
  const day = istDay(brk.ts - 1);
  const bars = dayBars.filter((b) => istDay(b.ts) === day && istMinute(b.ts) < SESSION_CLOSE_MIN).sort((a, b) => a.ts - b.ts);
  const closeAt = istAt(brk.ts - 1, SESSION_CLOSE_MIN);
  const last = bars[bars.length - 1];
  const complete = !!last && istMinute(last.ts) >= SESSION_CLOSE_MIN - 1;
  const priceBy = (target: number): number | null => {
    const cut = Math.min(target, closeAt);
    const done = bars.filter((b) => b.ts + 60_000 <= cut);
    if (!done.length) return null;
    const lastDone = done[done.length - 1];
    // Not yet covered: the bar that ends exactly at `cut` must exist, unless the session is complete
    // (then a missing minute is a gap and the last bar before the cut stands).
    if (lastDone.ts + 60_000 < cut && !complete) return null;
    return lastDone.close;
  };
  const p15 = priceBy(brk.ts + 15 * 60_000);
  const p60 = priceBy(brk.ts + 60 * 60_000);
  const pEod = complete ? last.close : null;
  const after = bars.filter((b) => b.ts >= brk.ts);
  const mv = (p: number | null) => (p === null ? null : round2((p - brk.price) * sgn));
  let mfe: number | null = null;
  let mae: number | null = null;
  if (complete && after.length) {
    mfe = round2(Math.max(...after.map((b) => (sgn > 0 ? b.high - brk.price : brk.price - b.low))));
    mae = round2(Math.min(...after.map((b) => (sgn > 0 ? b.low - brk.price : brk.price - b.high))));
  }
  return { priceAt15m: p15, priceAt60m: p60, priceEod: pEod, move15mPts: mv(p15), move60mPts: mv(p60), moveEodPts: mv(pEod), mfeEodPts: mfe, maeEodPts: mae, complete };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
