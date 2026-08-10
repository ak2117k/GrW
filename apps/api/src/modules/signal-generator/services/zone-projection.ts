import type { LevelType } from '../types/setup-context.types';
import type { EvidenceLevel } from '../types/evidence-level.types';
import type { StrongZone } from '../types/zone.types';
import type { LevelsSnapshot } from './signal-generator.service';
import { selectBarrier } from './barrier-selection';
import { sessionBudget } from './session-budget';
import {
  RR_FLOOR_STRICT,
  SL_BUFFER_ATR,
  collectLevelCandidates,
  computeSetupPrices,
  rewardRisk,
  type CandidateLevel,
} from './trade-plan';

/**
 * Projection zones — the entry box behind a broken level.
 *
 * See docs/superpowers/specs/2026-08-10-projection-zones-design.md §3.
 *
 * Pure, exactly as `buildTradePlan` is: no IO, no clock, no DI. The box is a
 * geometric expression of the SAME setup arithmetic the live path runs, which
 * is what makes it impossible for the drawn box and the trade it becomes to
 * disagree — there is one computation, not two.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Wire shape — spec §3.5. Locked: the overlay and the card both read it.
// ─────────────────────────────────────────────────────────────────────────────

export interface HitRate {
  pct: number;            // 0–100
  sample: number;         // resolved observations behind pct
  scope: 'symbol' | 'cohort';
}

export interface ProjectionBox {
  side: 'UP' | 'DOWN';
  state: 'armed' | 'confirmed';
  /** Broken level — the box's near edge. */
  breakLevel: number;
  /** Entry region. nearEdge is always the side closest to breakLevel. */
  entryNear: number;
  entryFar: number;
  stop: number;
  target: number;
  /**
   * What the target is, strongest first. `LEVEL` is the weak fallback — a
   * plain anchored level — and `ATR` means no structure was found at all.
   * Both are labelled so the card can say the projection is unsupported
   * rather than presenting it as a real barrier.
   */
  targetSource: 'OI_WALL' | 'HVN' | 'VALUE_AREA' | 'MAX_PAIN' | 'ZONE' | 'LEVEL' | 'ATR';
  /** 0–100. Why this price is expected to stop the move. Null for the ATR fallback. */
  conviction: number | null;
  cappedByHtf: boolean;
  /**
   * True when the barrier lies beyond the travel the rest of the session can
   * realistically deliver, so the box was drawn to that budget instead. The
   * reason names the barrier and says it is out of today's reach.
   */
  cappedBySession: boolean;
  rr: number;
  /** null = no measured history yet. NEVER a fabricated number. */
  hitRate: HitRate | null;
  reason: string;
}

export interface ProjectionZones {
  up: ProjectionBox | null;
  down: ProjectionBox | null;
}

/**
 * Chart timeframe → the ONE timeframe allowed to veto it. Spec §3.3.
 *
 * Exported because the caller has to fetch the right zone set before it can
 * pass `htfZones` in; a caller that guessed the mapping could cap a 5m box
 * against 15m structure and quietly contradict the spec's table.
 */
export const HTF_FOR_TIMEFRAME: Record<string, string | null> = {
  '1m': '15m',
  '5m': '1h',
  '15m': '1h',
  '1h': '1d',
  '1d': '1w',
  '1w': null,
  '1mo': null,
};

export interface BuildProjectionZonesInput {
  /** Chart timeframe, e.g. '15m'. Decides which HTF may cap the target. */
  timeframe: string;
  /** Current spot. Decides which zones count as already broken. */
  ltp: number | null | undefined;
  atr14: number | null | undefined;
  /** Zones on the chart timeframe: the broken one, and the obstacles above it. */
  zones?: StrongZone[] | null;
  /**
   * Zones on `HTF_FOR_TIMEFRAME[timeframe]`.
   *
   * `undefined`/`null` means the higher timeframe was NOT consulted, which is a
   * different statement from "consulted, nothing intervened" and the reason
   * sentence says so. Spec §4: an absent input degrades the box's claims, never
   * its correctness.
   */
  htfZones?: StrongZone[] | null;
  /** Evidence-weighted levels, used as target candidates 2 and 3. */
  evidence?: EvidenceLevel[] | null;
  /** Anchored snapshot. Consulted for ATR, and as the fallback anchor. */
  levels?: LevelsSnapshot | null;
  /**
   * Clock for the session budget. Supplied by the caller — this module stays
   * pure, so it never reads the clock itself. Omit it and no session cap is
   * applied (and the reason says the day was not sized).
   */
  now?: Date | null;
  /** Session hours differ by exchange. See session-budget.ts. */
  exchange?: string | null;
  /**
   * DAILY ATR — not the chart timeframe's. The budget asks how much of a
   * typical DAY's range is left, so a 15m ATR here would cap every projection
   * to a handful of points.
   */
  dailyAtr?: number | null;
}

const EMPTY_ZONES: ProjectionZones = { up: null, down: null };

/**
 * Prices closer than this are the same price. Without it a target that lands
 * exactly on the break level produces a zero-width box, which renders as a
 * hairline a trader would read as a real entry region.
 */
const EPS = 1e-6;

/**
 * Build both boxes. NEVER throws and NEVER fabricates: a side with no broken
 * zone, or one where the numbers leave no enterable region, is `null` — which
 * the UI renders as "already extended — no entry left", not as a flat box.
 */
export function buildProjectionZones(input: BuildProjectionZonesInput): ProjectionZones {
  try {
    return {
      up: buildBox(input, true),
      down: buildBox(input, false),
    };
  } catch {
    // Same contract as buildTradePlan: a pure helper that can take down the
    // whole composite is worse than one that admits it knows nothing. The
    // caller reports sources.projections = 'failed'. Spec §4.
    return EMPTY_ZONES;
  }
}

function buildBox(input: BuildProjectionZonesInput, isUp: boolean): ProjectionBox | null {
  const ltp = input.ltp;
  const atr = resolveAtr(input);
  if (!isPrice(ltp) || !isPrice(atr)) return null;

  const zones = Array.isArray(input.zones) ? input.zones : [];
  const anchor = findAnchor(zones, input.levels, ltp, isUp);
  if (!anchor) return null;

  // Near edge is the edge price crosses; the far side is what the stop hides
  // behind. Getting these the wrong way round would put the stop INSIDE the
  // zone, where the noise that formed the zone lives.
  const { breakLevel, farSide: zoneFarSide, flipped } = anchor;
  if (!isPrice(breakLevel) || !isPrice(zoneFarSide)) return null;

  // The stop and the ATR-fallback target come from the shared setup arithmetic
  // rather than from a local formula, so a box and the TradeTrigger it becomes
  // are the same numbers by construction. Spec §3.1, §6 "geometry parity".
  const base = computeSetupPrices({
    setupType: 'BREAKOUT',
    isLong: isUp,
    level: zoneFarSide,
    atr,
    candidates: [],
  });
  if (!base) return null;
  const stop = base.stoploss;

  // The next HIGH-CONVICTION barrier, not the nearest level. Nearest-level
  // targeting made every projection a treadmill: a break of ORH aimed at the
  // round number twenty points up, and breaking that aimed at the next. The
  // minor levels in between are terrain to cross, not destinations. Spec §0.2.
  const barrier = selectBarrier({
    from: breakLevel,
    isUp,
    atr,
    zones: (input.zones ?? []).filter((z) => z && z.id !== anchor.id),
    evidence: input.evidence,
    levels: anchorLevelPrices(input.levels),
  });
  const rawTarget = barrier ? barrier.price : atrFallbackTarget(breakLevel, stop, isUp);
  const targetSource: ProjectionBox['targetSource'] = barrier ? barrier.kind : 'ATR';

  const htf = capToHtf({ input, isUp, breakLevel, target: rawTarget });
  // Both caps can only ever move the target CLOSER, so applying them in
  // sequence is safe in either order — the tighter one simply wins.
  const budget = capToSessionBudget({ input, isUp, breakLevel, target: htf.target });
  const capped = {
    target: budget.target,
    cappedByHtf: htf.cappedByHtf,
    cappedBySession: budget.cappedBySession,
    note: `${htf.note}${budget.note}`,
  };
  const target = capped.target;

  // Solved, not guessed: with stop and target fixed, reward:risk is monotonic
  // in entry, so there is exactly one entry at which it equals the floor.
  const entryFar = solveFarEdge(stop, target);
  const entryNear = breakLevel;

  // A far edge that has not cleared the near edge means the only entry worth
  // taking is the break level itself. That USED to null the box, back when the
  // box WAS the entry region — but the box is now the projected travel, and a
  // degenerate inner band is no reason to delete the whole projection.
  //
  // It was also a boundary the geometry hit constantly: a level anchor is a
  // line, so risk is SL_BUFFER_ATR (0.25) x ATR, while the barrier noise filter
  // admits targets from 0.5 x ATR — exactly 2 x risk. Entry room is
  // (n - 2) / 3 x risk, so every barrier sitting near that threshold produced
  // EXACTLY zero room and silently suppressed the box. That is why projections
  // appeared on one timeframe and not another, and why they came and went.
  //
  // Whether the trade is worth taking is the R:R floor's job, checked below.
  if (!Number.isFinite(entryFar)) return null;
  const clampedFar = isUp
    ? Math.max(entryFar, entryNear)
    : Math.min(entryFar, entryNear);

  // Reported at the near edge: that is the best entry the box offers, and it is
  // the number the card quotes. Anywhere inside the box it is lower, but never
  // below the floor — that is what the far edge solve guarantees.
  const rr = rewardRisk(entryNear, stop, target);
  if (!Number.isFinite(rr) || rr < RR_FLOOR_STRICT) return null;

  const state: 'armed' | 'confirmed' = flipped ? 'confirmed' : 'armed';

  return {
    side: isUp ? 'UP' : 'DOWN',
    state,
    breakLevel,
    entryNear,
    entryFar: clampedFar,
    stop,
    target,
    targetSource,
    conviction: barrier ? barrier.conviction : null,
    cappedByHtf: capped.cappedByHtf,
    cappedBySession: capped.cappedBySession,
    rr,
    // Slice A ships geometry only. A percentage the platform has not measured
    // is worse than no percentage, so this stays null until Slice B fills it.
    hitRate: null,
    reason: sentence(
      `${isUp ? 'Break above' : 'Break below'} ${fmt(breakLevel)} (${state}): enter ` +
        `${fmt(Math.min(entryNear, entryFar))}–${fmt(Math.max(entryNear, entryFar))}, ` +
        `stop ${fmt(stop)}, target ${fmt(target)} ${describeSource(targetSource)} ` +
        `(${fmtRr(rr)}).${capped.note} No measured history yet.`,
    ),
  };
}

/**
 * The zone this side's box is anchored on: the one in play, nearest to spot.
 *
 * Deliberately NOT restricted to zones price has already crossed. That
 * restriction made the ARMED state — the dimmed "if this breaks, here is the
 * plan" box drawn while price is still trapped UNDER a resistance — impossible
 * to reach, so a range-bound chart drew nothing at all. That is the exact case
 * a trader is watching a level for, and it is the reason the feature exists.
 *
 * A zone that flipped keeps its pre-flip polarity in `wasType`, so the
 * confirmed case (flipped resistance now acting as support) and the armed
 * cases (price through an unconfirmed break, or not yet there at all) are one
 * search. Nearest wins because a level three zones away is not the level a
 * trader is looking at.
 */
interface ProjectionAnchor {
  /** The price a break crosses — the box's near edge. */
  breakLevel: number;
  /** The far side of the structure, which the stop hides behind. */
  farSide: number;
  /** True once the engine has confirmed the break (a flipped zone). */
  flipped: boolean;
  /** Stable id, used to exclude the anchor from its own target search. */
  id: string;
}

/**
 * The structure this side's box is anchored on.
 *
 * Zones first, because a band carries a real far side for the stop to hide
 * behind. But the detector needs ten candles, a valid ATR AND clustered pivots,
 * and for an index it routinely produces none — which left the box with nothing
 * to anchor on while the level book had ORH, PDH and round levels drawn on the
 * very same chart. So an anchored LEVEL is the fallback: a line rather than a
 * band, with the stop taken a buffer below it exactly as the live setup path
 * does for line levels. Spec §0.4.
 *
 * A chart showing levels can therefore always project from one.
 */
function findAnchor(
  zones: StrongZone[],
  levels: LevelsSnapshot | null | undefined,
  ltp: number,
  isUp: boolean,
): ProjectionAnchor | null {
  const zone = findAnchorZone(zones, ltp, isUp);
  if (zone) {
    return {
      breakLevel: isUp ? zone.upper : zone.lower,
      farSide: isUp ? zone.lower : zone.upper,
      flipped: !!zone.flippedAt,
      id: zone.id,
    };
  }

  if (!levels) return null;
  const candidates = collectLevelCandidates({
    pdh: levels.pdh,
    pdl: levels.pdl,
    vwap: levels.vwap,
    orh: levels.orh,
    orl: levels.orl,
  }).filter((c) => isPrice(c.value));
  if (candidates.length === 0) return null;

  // Nearest level AHEAD on this side. The side filter is load-bearing: without
  // it both boxes select the same nearest-by-distance level (VWAP sitting on
  // spot wins for up AND down), and the two sides describe the same break in
  // opposite directions.
  //
  // "Ahead" mirrors the armed case exactly — the resistance price is trapped
  // under, or the support it is sitting above.
  const ahead = candidates.filter((c) => (isUp ? c.value > ltp + EPS : c.value < ltp - EPS));
  if (ahead.length === 0) return null;

  // A level is a line, so breakLevel and farSide coincide and the stop comes
  // from the shared buffer rather than from a band width.
  const nearest = ahead.reduce<CandidateLevel | null>(
    (best, c) => (best === null || Math.abs(c.value - ltp) < Math.abs(best.value - ltp) ? c : best),
    null,
  );
  if (!nearest) return null;

  return {
    breakLevel: nearest.value,
    farSide: nearest.value,
    // A level cannot record a confirmed break — only a zone flip does that, so
    // a level-anchored box is always ARMED. Claiming 'confirmed' off a bare
    // level would assert a confirmation nothing actually checked.
    flipped: false,
    id: `level:${nearest.type}:${nearest.value}`,
  };
}

function findAnchorZone(zones: StrongZone[], ltp: number, isUp: boolean): StrongZone | null {
  const wanted = isUp ? 'resistance' : 'support';

  const candidates = zones.filter(
    (z) =>
      z &&
      (z.type === wanted || z.wasType === wanted) &&
      isPrice(z.upper) &&
      isPrice(z.lower),
  );
  if (candidates.length === 0) return null;

  const edgeOf = (z: StrongZone) => (isUp ? z.upper : z.lower);
  const nearest = (pool: StrongZone[]) =>
    pool.reduce<StrongZone | null>(
      (best, z) =>
        best === null || Math.abs(edgeOf(z) - ltp) < Math.abs(edgeOf(best) - ltp) ? z : best,
      null,
    );

  // A CONFIRMED break outranks a level still ahead: once the engine has
  // accepted the break that is the live trade, and the level above it becomes
  // that trade's target rather than a second box.
  const flipped = candidates.filter((z) => z.flippedAt);
  return nearest(flipped.length > 0 ? flipped : candidates);
}

type TargetSource = ProjectionBox['targetSource'];



/**
 * Spec §3.3. A cap can only ever pull the target CLOSER.
 *
 * The asymmetry is the whole point: the higher timeframe is allowed to say
 * "there is a wall in the way", never "there is more room than you think". A
 * cap that leaves too little reward is handled upstream by the far-edge solve,
 * which collapses the box — the higher timeframe vetoing the trade outright.
 */
/** The anchored level prices, as the barrier selector's weakest candidate class. */
function anchorLevelPrices(levels: LevelsSnapshot | null | undefined): number[] {
  if (!levels) return [];
  return collectLevelCandidates({
    pdh: levels.pdh,
    pdl: levels.pdl,
    vwap: levels.vwap,
    orh: levels.orh,
    orl: levels.orl,
  })
    .map((c) => c.value)
    .filter((v) => isPrice(v));
}

/**
 * Cap the target at the travel the rest of the session can realistically
 * deliver. Spec §0.3.
 *
 * A 113-point target issued at 12:44 on a low-volatility day with most of the
 * daily range already spent is not wrong about structure — it is wrong about
 * time. Like the HTF cap this can only ever take room away.
 *
 * A budget of `null` means the day could NOT be sized (no daily ATR, or no
 * clock supplied). That is not permission to project without limit, but it is
 * also not a reason to draw nothing — the target stands and the reason says
 * the day was not sized, so the claim is weaker rather than silently absent.
 */
function capToSessionBudget(args: {
  input: BuildProjectionZonesInput;
  isUp: boolean;
  breakLevel: number;
  target: number;
}): { target: number; cappedBySession: boolean; note: string } {
  const { input, isUp, breakLevel, target } = args;
  if (!input.now) return { target, cappedBySession: false, note: '' };

  const budget = sessionBudget({
    now: input.now,
    exchange: input.exchange ?? 'NSE',
    dailyAtr: input.dailyAtr ?? null,
    todayHigh: input.levels?.todayHigh ?? null,
    todayLow: input.levels?.todayLow ?? null,
  });
  if (budget.points === null) {
    return { target, cappedBySession: false, note: " Today's range was not sized." };
  }

  const reach = isUp ? breakLevel + budget.points : breakLevel - budget.points;
  const beyond = isUp ? target > reach + EPS : target < reach - EPS;
  if (!beyond) return { target, cappedBySession: false, note: '' };

  return {
    target: reach,
    cappedBySession: true,
    note: ` Barrier ${fmt(target)} is beyond today's remaining range (${budget.reason}).`,
  };
}

function capToHtf(args: {
  input: BuildProjectionZonesInput;
  isUp: boolean;
  breakLevel: number;
  target: number;
}): { target: number; cappedByHtf: boolean; note: string } {
  const { input, isUp, breakLevel, target } = args;

  const htf = HTF_FOR_TIMEFRAME[input.timeframe] ?? null;
  if (htf === null) return { target, cappedByHtf: false, note: '' };
  if (!Array.isArray(input.htfZones)) {
    // Silence here would be indistinguishable from "checked, nothing in the
    // way" — a projection presented as HTF-clean when it was never checked.
    return { target, cappedByHtf: false, note: ` ${htf} structure was not checked.` };
  }

  let capped: number | null = null;
  for (const z of input.htfZones) {
    if (!z || (z.classification !== 'STRONG' && z.classification !== 'MEDIUM')) continue;
    if (!isPrice(z.upper) || !isPrice(z.lower)) continue;
    const edge = isUp ? z.lower : z.upper;
    // Strictly between: a zone at or beyond the target caps nothing, and one
    // behind the break level is not in the path of this move at all.
    const between = isUp
      ? edge > breakLevel + EPS && edge < target - EPS
      : edge < breakLevel - EPS && edge > target + EPS;
    if (!between) continue;
    if (capped === null) capped = edge;
    else capped = isUp ? Math.min(capped, edge) : Math.max(capped, edge);
  }

  if (capped === null) return { target, cappedByHtf: false, note: '' };
  return { target: capped, cappedByHtf: true, note: ` Capped by ${htf} structure.` };
}

/**
 * The entry at which reward:risk falls exactly to the floor.
 *
 * From `|target − entry| / |entry − stop| = RR_FLOOR_STRICT` with target and
 * stop on opposite sides of entry, both directions collapse to the same
 * expression — a weighted mean of target and stop. Hand-tuning this number is
 * how a box and its R:R floor drift apart.
 */
export function solveFarEdge(stop: number, target: number): number {
  return (target + RR_FLOOR_STRICT * stop) / (1 + RR_FLOOR_STRICT);
}

/**
 * Reward multiple for the no-structure fallback, in units of the risk taken
 * from the BREAK LEVEL.
 *
 * It cannot be RR_FLOOR_STRICT. Substituting a target `n` risk-units away into
 * `solveFarEdge` gives a box exactly `(n − 2) / 3` risk-units wide, so `n = 2`
 * is a zero-width box and anything below it is inverted — the fallback would
 * silently never draw. Three is the smallest whole multiple that leaves a
 * region (a third of the risk), and it keeps the fallback visibly more
 * demanding than a structural target, which only has to clear the floor.
 */
const ATR_FALLBACK_R = 3;

/**
 * Target for a break with NOTHING ahead of it.
 *
 * Measured from `breakLevel` — where entry actually happens — not from the
 * zone's far side. Anchoring it on the far side (as the setup maths does, since
 * a live breakout enters just past the level it broke) put the whole reward
 * INSIDE the zone: the solved far edge landed below the break level and every
 * fallback box came out null for any zone wider than 0.15×ATR.
 *
 * This target is invented, not observed. `targetSource: 'ATR'` is what tells
 * the card to say so.
 */
function atrFallbackTarget(breakLevel: number, stop: number, isUp: boolean): number {
  const risk = Math.abs(breakLevel - stop);
  return isUp ? breakLevel + ATR_FALLBACK_R * risk : breakLevel - ATR_FALLBACK_R * risk;
}

function resolveAtr(input: BuildProjectionZonesInput): number | null {
  if (isPrice(input.atr14)) return input.atr14;
  const fromLevels = input.levels?.atr14;
  return isPrice(fromLevels) ? fromLevels : null;
}

function describeSource(source: TargetSource): string {
  switch (source) {
    case 'OI_WALL':
      return 'at the option-chain wall';
    case 'HVN':
      return 'at the high-volume node';
    case 'VALUE_AREA':
      return 'at the value area edge';
    case 'MAX_PAIN':
      return 'at max pain';
    case 'ZONE':
      return 'at the next tested zone';
    case 'LEVEL':
      // Named as the weak class it is. Aiming at a plain level is what made
      // every projection a treadmill, so when it is all we have the card says
      // so rather than dressing it up. Spec §0.2.
      return 'at the next level (no stronger barrier ahead)';
    default:
      // Labelled, always. A measured-distance fallback dressed up as structure
      // is the one lie this object must never tell. Spec §3.2, §4.
      return 'from an ATR projection (no structure ahead)';
  }
}

function isPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function fmt(v: number): string {
  return v.toFixed(2);
}

function fmtRr(rr: number): string {
  return `1:${rr.toFixed(1)}`;
}

/**
 * Same last line of defence as the trade plan's: engine debug strings must
 * never reach a trader. Every sentence above is built from numbers and enum
 * labels, so this can only be a no-op today — it earns its keep the day someone
 * interpolates a raw engine string into a reason.
 */
function sentence(text: string): string {
  return text
    .replace(/\breject:\S*/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// SL_BUFFER_ATR is re-exported so the overlay and the observation writer can
// describe the stop's derivation without importing two modules for one box.
export { RR_FLOOR_STRICT, SL_BUFFER_ATR };
