import { DEFAULT_SESSION_MINUTES } from './noise';
import type { PositionSide } from './types';

/**
 * TARGET LADDER FOR REAL POSITIONS (owner 2026-11-03, signal trading live: "same rules as paper"). Pure.
 *
 * A live signal order carries its entry LIMIT and its stop only — no target order — and the paper trades
 * manage their targets in signal-trader/domain/paper.ts. The real positions now get the same ladder, run by
 * the trade-sentinel cycle on every pass:
 *  - several targets: T1 reached → the stop moves to the entry (breakeven); T(n) reached → the stop moves to
 *    T(n−1); the LAST target reached → exit (rule TARGET);
 *  - one target: reaching it does not exit — the stop hands over to the NOISE TRAIL (trailN contract noise
 *    units behind the best price, never below the entry; the entry itself while N is unknown), as paper does;
 *  - the stop only ever ratchets in the trade's favour (`prevStop` is never loosened), and once a moved stop
 *    is crossed the position exits (rule TARGET_TRAIL).
 * The stop BEFORE T1 is not this rule's: a signal trade's own SL is the armed price trigger, a manual trade's
 * is the owner's. "Reached" is measured on the best price since entry (the tracker's holdingHigh / holdingLow,
 * a durable column) together with this LTP, so a restart can never forget a target already reached.
 *
 * Not ported from paper: the breakeven guard (PAPER_STEP_MIN_N) — a real stop steps at the target, as the owner
 * stated the rule. The exit is confirmed like the hard floor (two reads ≥ FLOOR_HARD_CONFIRM_SEC apart) and goes
 * through the same verdict → executor → exit-gate path, whose TARGET_LADDER clause re-checks it (gate.ts).
 */
export type LadderRule = 'TARGET' | 'TARGET_TRAIL';

/** Where a position's targets (and the stop that sized them) came from. */
export type LadderSource = 'signal' | 'ai-trigger' | 'atr-default';

/**
 * `money.ladder` in the sentinel packet. WIRE CONTRACT: written by trade-sentinel, read by the exit gate
 * (packet-facts.ts) and shown with the position. A `type` (not an interface) so it stays Prisma JSON.
 */
export type PacketLadder = {
  v: 1;
  source: LadderSource;
  /** How the targets were set (the signal plan, or the engine rule with its R). */
  detail: string;
  entry: number;
  /** The stop the targets were sized from (R = |entry − riskStop|); null for a signal plan without one. */
  riskStop: number | null;
  /** Nearest first, all beyond the entry. */
  targets: number[];
  /** Targets reached so far (0 … targets.length). */
  stage: number;
  /** The ladder's stop now; null before T1. */
  stop: number | null;
  /** The best price since entry the stage was read from. */
  best: number;
  /** The last target of a several-target ladder was reached: the position exits. */
  lastHit: boolean;
  /** A one-target position past its target: the stop is the noise trail. */
  trailing: boolean;
  /** The ladder's exit is carried out (a SENTINEL-owned F&O position, TARGET_LADDER=on); false = shown only. */
  enforced: boolean;
};

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The plan's targets beyond the entry in the position's direction, nearest first (wrong-side ones dropped). */
export function ladderTargets(side: PositionSide, entry: number, targets: readonly unknown[] | null | undefined): number[] {
  if (!Array.isArray(targets) || !fin(entry) || entry <= 0) return [];
  const long = side === 'LONG';
  const ok = targets.map(Number).filter((t) => fin(t) && t > 0 && (long ? t > entry : t < entry));
  return [...new Set(ok)].sort((a, b) => (long ? a - b : b - a));
}

export interface LadderInput {
  side: PositionSide;
  entry: number;
  targets: number[];
  /** Best price since entry (holdingHigh long / holdingLow short); null = unknown (the LTP stands in). */
  best: number | null;
  ltp: number;
  /** The contract's 1-minute noise unit, for the one-target trail; null = unknown (the trail sits at the entry). */
  nContract: number | null;
  /** FLOOR_TRAIL_N: the trail's distance behind the best price, in N. */
  trailN: number;
  /** The stop already reached (cycle memory / the last packet): never loosened. */
  prevStop: number | null;
}

export interface LadderReading {
  stage: number;
  stop: number | null;
  best: number;
  lastHit: boolean;
  trailing: boolean;
  /** The exit this read calls for (unconfirmed — the cycle confirms it); null = hold. */
  trip: LadderRule | null;
  detail: string;
}

export function ladderReading(i: LadderInput): LadderReading {
  const long = i.side === 'LONG';
  const ts = ladderTargets(i.side, i.entry, i.targets);
  const best = fin(i.best) && i.best > 0 ? (long ? Math.max(i.best, i.ltp) : Math.min(i.best, i.ltp)) : i.ltp;
  const beyond = (p: number, level: number) => (long ? p >= level - 1e-9 : p <= level + 1e-9);
  const tighter = (a: number, b: number | null) => b === null || (long ? a > b : a < b);
  const k = ts.filter((t) => beyond(best, t)).length;

  let computed: number | null = null;
  let trailing = false;
  let how = '';
  if (ts.length === 1 && k === 1) {
    trailing = true;
    const n = fin(i.nContract) && i.nContract > 0 && i.trailN > 0 ? i.nContract : null;
    const raw = n === null ? i.entry : long ? best - i.trailN * n : best + i.trailN * n;
    computed = r2(long ? Math.max(i.entry, raw) : Math.min(i.entry, raw));
    how = `only target ${ts[0]} reached (best ${r2(best)}): noise trail ${n === null ? 'at the entry (N unknown)' : `${i.trailN}× N ${r2(n)} behind the best, floored at the entry`}`;
  } else if (k >= 1) {
    computed = k === 1 ? i.entry : ts[k - 2];
    how = `T${k} ${ts[k - 1]} reached (best ${r2(best)}): stop at ${k === 1 ? 'the entry' : `T${k - 1}`}`;
  }
  const prev = fin(i.prevStop) && i.prevStop > 0 ? i.prevStop : null;
  const stop = computed !== null && tighter(computed, prev) ? computed : prev;
  const lastHit = ts.length >= 2 && k === ts.length;
  const crossed = stop !== null && (long ? i.ltp <= stop + 1e-9 : i.ltp >= stop - 1e-9);
  const trip: LadderRule | null = lastHit ? 'TARGET' : crossed ? 'TARGET_TRAIL' : null;
  const detail =
    trip === 'TARGET'
      ? `last target T${ts.length} ${ts[ts.length - 1]} reached (best ${r2(best)}, LTP ${i.ltp}) — exit`
      : trip === 'TARGET_TRAIL'
      ? `LTP ${i.ltp} crossed the ladder stop ${stop}${how ? ` (${how})` : ''}`
      : k === 0
      ? `no target reached yet (best ${r2(best)}; T1 ${ts[0] ?? 'none'})`
      : `${how}${stop !== computed ? ` — kept the tighter stop ${stop}` : ''}`;
  return { stage: k, stop, best: r2(best), lastHit, trailing, trip, detail };
}

/**
 * The R for a manual position whose stop is unknown (owner: "give them targets as we do for the others"):
 * 1 × the contract's DAILY ATR, approximated as its 1-minute noise unit × √(session minutes) — the inverse of
 * exit-discipline's daily → 1-minute scaling, and the paper watch's fallback for a carried trade's daily ATR
 * (trade-setup sizes its stop at 1 × daily ATR too). A long is capped at half its entry price so the stop
 * stays a positive price (an option premium's daily range can rival the premium). Null = N unknown.
 */
export function defaultLadderStop(side: PositionSide, entry: number, nContract: number | null, sessionMinutes = DEFAULT_SESSION_MINUTES): number | null {
  if (!fin(entry) || entry <= 0 || !fin(nContract) || nContract <= 0) return null;
  let risk = nContract * Math.sqrt(sessionMinutes);
  if (side === 'LONG') risk = Math.min(risk, entry * 0.5);
  return r2(side === 'LONG' ? entry - risk : entry + risk);
}

/** TARGET_LADDER: on (exits carried out) | observe (targets computed and shown, no exit) | off. Default on. */
export type LadderMode = 'on' | 'observe' | 'off';
export function parseLadderMode(raw: string | undefined): LadderMode {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'off' || v === 'false' ? 'off' : v === 'observe' ? 'observe' : 'on';
}
