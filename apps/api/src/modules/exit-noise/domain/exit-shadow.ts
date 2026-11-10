/**
 * The exit shadow record (owner 2026-11-10: "record each exit's noise reading before it happens"). The exit-floor
 * replay (research/exit-floor-replay, 2026-11-10) found no case for changing the exit rule on 13 live exits, and
 * could not test a gate honestly: P(adverse) was computed by the night review, not at the exit, and a third of
 * the cases had no price after the exit. So every exit now keeps, at the moment it fires:
 *  - P(adverse) and its parts, from the same read and the news known by then ({@link ExitShadow});
 *  - what the candidate gate would have done ({@link shadowGate}): HOLD when the read says NOISE and p < 0.40
 *    (the only gate the replay left open), with the hard stop kept;
 * and, 60 minutes later, the position's own price path ({@link positionFollow}) so the case is already priced.
 * RECORD ONLY: no exit path reads any of it. Re-run the replay at {@link SHADOW_LIVE_CASES_NEEDED} live cases. Pure.
 */
import type { AdverseProbability } from './adverse-probability';
import type { NoiseVerdict } from './noise-read';

/** The candidate gate the replay left open: hold a floor / AI exit when the read says NOISE and p is under this. */
export const SHADOW_HOLD_MAX_P = 0.4;
/** Live exits with a shadow record needed before the exit rule is replayed again (owner agreed 2026-11-10). */
export const SHADOW_LIVE_CASES_NEEDED = 30;
/** Minutes of the position's own price followed after the exit (the replay's H30 / H60 horizons). */
export const POSITION_FOLLOW_MIN = 60;

export interface ShadowGate {
  rule: string;
  /** The gate would have held instead of exiting. */
  wouldHold: boolean;
  why: string;
}

export interface ExitShadow {
  /** When p was computed (the exit time: data after it is never read). */
  at: string;
  p: number | null;
  basis: AdverseProbability['basis'];
  from: AdverseProbability['from'];
  parts: Array<{ name: string; contribution: number; read: boolean; note: string }>;
  gate: ShadowGate;
  /** The exit was the code floor (FLOOR_HARD), not the AI: the case the replay is about. */
  floorHard: boolean;
}

export const SHADOW_RULE = `hold if read NOISE and p < ${SHADOW_HOLD_MAX_P} (hard stop kept)`;

export function shadowGate(verdict: NoiseVerdict | string, p: number | null): ShadowGate {
  if (verdict !== 'NOISE') return { rule: SHADOW_RULE, wouldHold: false, why: `read ${verdict}` };
  if (p === null) return { rule: SHADOW_RULE, wouldHold: false, why: 'read NOISE but no p' };
  if (p >= SHADOW_HOLD_MAX_P) return { rule: SHADOW_RULE, wouldHold: false, why: `read NOISE, p ${p} ≥ ${SHADOW_HOLD_MAX_P}` };
  return { rule: SHADOW_RULE, wouldHold: true, why: `read NOISE, p ${p} < ${SHADOW_HOLD_MAX_P}` };
}

/** A FLOOR_HARD exit by its reason text (ai_exit_executions.verdictReason / the paper exit's reason). */
export function isFloorHard(reason: unknown): boolean {
  return typeof reason === 'string' && /FLOOR_HARD/.test(reason);
}

export function exitShadow(at: Date, verdict: NoiseVerdict | string, adverse: AdverseProbability | null, floorHard: boolean): ExitShadow {
  const p = adverse?.p ?? null;
  return {
    at: at.toISOString(),
    p,
    basis: adverse?.basis ?? 'heuristic-v1',
    from: adverse?.from ?? 'none',
    parts: (adverse?.parts ?? []).map((x) => ({ name: x.name, contribution: x.contribution, read: x.read, note: x.note.slice(0, 200) })),
    gate: shadowGate(verdict, p),
    floorHard,
  };
}

export interface PricePoint {
  at: Date;
  price: number;
}

export interface PositionFollow {
  exitPrice: number | null;
  /** The position's price nearest +30 / +60 min (within {@link MARK_TOLERANCE_MIN}). */
  after30m: number | null;
  after60m: number | null;
  /** Best / worst price for the position in the 60 minutes (long: high / low; short: low / high). */
  best60m: number | null;
  worst60m: number | null;
  /** Per unit, for the position: + = holding would have made more than the exit. */
  hold30mPerUnit: number | null;
  hold60mPerUnit: number | null;
  points: number;
}

/** Snapshots are ~3 min apart, so a mark is the point nearest it within this. */
const MARK_TOLERANCE_MIN = 4;
const MIN = 60_000;
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The position's own price in the {@link POSITION_FOLLOW_MIN} minutes after the exit, from the points that come
 * strictly after it. `long` = the position was bought (an option buyer is long the premium). Pure.
 */
export function positionFollow(long: boolean, exitAt: Date, exitPrice: number | null, points: readonly PricePoint[]): PositionFollow {
  const t0 = exitAt.getTime();
  const after = points.filter((x) => x.at.getTime() > t0 && x.at.getTime() <= t0 + (POSITION_FOLLOW_MIN + 1) * MIN && Number.isFinite(x.price) && x.price > 0);
  const mark = (min: number) => {
    let best: { d: number; p: number } | null = null;
    for (const x of after) {
      const d = Math.abs(x.at.getTime() - (t0 + min * MIN));
      if (d <= MARK_TOLERANCE_MIN * MIN && (!best || d < best.d)) best = { d, p: x.price };
    }
    return best?.p ?? null;
  };
  const after30m = mark(30);
  const after60m = mark(POSITION_FOLLOW_MIN);
  const prices = after.map((x) => x.price);
  const hi = prices.length ? Math.max(...prices) : null;
  const lo = prices.length ? Math.min(...prices) : null;
  const ex = exitPrice !== null && Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : null;
  const hold = (p: number | null) => (p === null || ex === null ? null : r2(long ? p - ex : ex - p));
  return {
    exitPrice: ex,
    after30m,
    after60m,
    best60m: long ? hi : lo,
    worst60m: long ? lo : hi,
    hold30mPerUnit: hold(after30m),
    hold60mPerUnit: hold(after60m),
    points: after.length,
  };
}

/** The follow has its +60 mark (or the window is over and nothing more will come). */
export function positionFollowDone(f: PositionFollow): boolean {
  return f.after60m !== null;
}
