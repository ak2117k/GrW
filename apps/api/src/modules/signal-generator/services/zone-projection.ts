import type { LevelType } from '../types/setup-context.types';
import type { EvidenceLevel } from '../types/evidence-level.types';
import type { StrongZone } from '../types/zone.types';
import type { LevelsSnapshot } from './signal-generator.service';
import {
  RR_FLOOR_STRICT,
  SL_BUFFER_ATR,
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
  targetSource: 'ZONE' | 'EVIDENCE' | 'POC' | 'VALUE_AREA' | 'MAX_PAIN' | 'ATR';
  cappedByHtf: boolean;
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
  /** Anchored snapshot. Only consulted for ATR when `atr14` is absent. */
  levels?: LevelsSnapshot | null;
}

const EMPTY_ZONES: ProjectionZones = { up: null, down: null };

/**
 * Prices closer than this are the same price. Without it a target that lands
 * exactly on the break level produces a zero-width box, which renders as a
 * hairline a trader would read as a real entry region.
 */
const EPS = 1e-6;

/** Evidence below this score is noise, not a level worth aiming at. Spec §3.2. */
const EVIDENCE_TARGET_SCORE_FLOOR = 60;

/** Evidence kinds that get their own `targetSource` label. Spec §3.2 rule 3. */
const PROFILE_KINDS = ['POC', 'VALUE_AREA', 'MAX_PAIN'] as const;
type ProfileKind = (typeof PROFILE_KINDS)[number];

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
  const broken = findBrokenZone(zones, ltp, isUp);
  if (!broken) return null;

  // Near edge is the edge price actually crossed; the far side is what the stop
  // hides behind. Getting these the wrong way round would put the stop INSIDE
  // the zone, where the noise that formed the zone lives.
  const breakLevel = isUp ? broken.upper : broken.lower;
  const zoneFarSide = isUp ? broken.lower : broken.upper;
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

  const picked = selectTarget({ input, isUp, breakLevel, zoneFarSide, atr, brokenId: broken.id });
  const rawTarget = picked ? picked.target : atrFallbackTarget(breakLevel, stop, isUp);
  const targetSource = picked ? picked.source : 'ATR';

  const capped = capToHtf({ input, isUp, breakLevel, target: rawTarget });
  const target = capped.target;

  // Solved, not guessed: with stop and target fixed, reward:risk is monotonic
  // in entry, so there is exactly one entry at which it equals the floor.
  const entryFar = solveFarEdge(stop, target);
  const entryNear = breakLevel;

  // A far edge that has not cleared the near edge means price has already taken
  // the whole reward; there is no enterable region left. Returning a box here
  // would draw a zero-width or inverted band.
  const room = isUp ? entryFar - entryNear : entryNear - entryFar;
  if (!Number.isFinite(room) || room <= EPS) return null;

  // Reported at the near edge: that is the best entry the box offers, and it is
  // the number the card quotes. Anywhere inside the box it is lower, but never
  // below the floor — that is what the far edge solve guarantees.
  const rr = rewardRisk(entryNear, stop, target);
  if (!Number.isFinite(rr) || rr < RR_FLOOR_STRICT) return null;

  const state: 'armed' | 'confirmed' = broken.flippedAt ? 'confirmed' : 'armed';

  return {
    side: isUp ? 'UP' : 'DOWN',
    state,
    breakLevel,
    entryNear,
    entryFar,
    stop,
    target,
    targetSource,
    cappedByHtf: capped.cappedByHtf,
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
 * The zone price has already left behind, nearest to spot.
 *
 * A zone that flipped keeps its pre-flip polarity in `wasType`, so both the
 * confirmed case (flipped resistance now acting as support) and the armed case
 * (price through a resistance the detector has not confirmed) are the same
 * search. Nearest wins because a break three zones ago is not the break a
 * trader is looking at.
 */
function findBrokenZone(zones: StrongZone[], ltp: number, isUp: boolean): StrongZone | null {
  const wanted = isUp ? 'resistance' : 'support';
  let best: StrongZone | null = null;
  for (const z of zones) {
    if (!z || (z.type !== wanted && z.wasType !== wanted)) continue;
    if (!isPrice(z.upper) || !isPrice(z.lower)) continue;
    const edge = isUp ? z.upper : z.lower;
    if (isUp ? ltp <= edge : ltp >= edge) continue;
    if (best === null) best = z;
    else {
      const bestEdge = isUp ? best.upper : best.lower;
      if (isUp ? edge > bestEdge : edge < bestEdge) best = z;
    }
  }
  return best;
}

type TargetSource = ProjectionBox['targetSource'];

interface TargetCandidate {
  value: number;
  source: TargetSource;
}

/**
 * Spec §3.2: first qualifying candidate, nearest first, by priority class.
 *
 * Each class is offered to `computeSetupPrices` on its own rather than merged
 * into one list, because that function picks the nearest candidate overall —
 * merging would let a weak evidence level outrank a STRONG zone purely by being
 * closer, which is precisely the ordering the spec pins down. Reusing it also
 * means the minimum-distance rule and the side filter are the live ones.
 */
function selectTarget(args: {
  input: BuildProjectionZonesInput;
  isUp: boolean;
  breakLevel: number;
  zoneFarSide: number;
  atr: number;
  brokenId: string;
}): { target: number; source: TargetSource } | null {
  const { input, isUp, breakLevel, zoneFarSide, atr, brokenId } = args;

  for (const cls of targetClasses(input, isUp, brokenId)) {
    // Anything not strictly beyond the break level is behind the trader, not in
    // front of them. Filtering here — not inside the setup maths, whose entry
    // sits below the break level for an up-break — is what makes "never selects
    // a level on the wrong side of the break" true.
    const ahead = cls.filter((c) => (isUp ? c.value > breakLevel + EPS : c.value < breakLevel - EPS));
    if (ahead.length === 0) continue;

    const prices = computeSetupPrices({
      setupType: 'BREAKOUT',
      isLong: isUp,
      level: zoneFarSide,
      atr,
      candidates: ahead.map((c): CandidateLevel => ({ type: 'ROUND' as LevelType, value: c.value })),
    });
    if (!prices) continue;

    const hit = ahead.find((c) => c.value === prices.target);
    // No hit means the class was there but too close to qualify, and the maths
    // fell back to its own 2R target. That is not this class's answer, so we
    // keep descending rather than mislabelling a fallback as structure.
    if (hit) return { target: hit.value, source: hit.source };
  }
  return null;
}

function targetClasses(
  input: BuildProjectionZonesInput,
  isUp: boolean,
  brokenId: string,
): TargetCandidate[][] {
  const zones = Array.isArray(input.zones) ? input.zones : [];
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];

  const zoneCandidates: TargetCandidate[] = zones
    .filter(
      (z) =>
        z &&
        z.id !== brokenId &&
        (z.classification === 'STRONG' || z.classification === 'MEDIUM') &&
        isPrice(z.upper) &&
        isPrice(z.lower),
    )
    // Near edge: the side the move meets first. A target set at the far side
    // would ask a trader to hold through the whole obstacle.
    .map((z) => ({ value: isUp ? z.lower : z.upper, source: 'ZONE' as TargetSource }));

  const scored: TargetCandidate[] = evidence
    .filter((e) => e && isPrice(e.price) && typeof e.score === 'number' && e.score >= EVIDENCE_TARGET_SCORE_FLOOR)
    .map((e) => ({ value: e.price, source: 'EVIDENCE' as TargetSource }));

  const profile: TargetCandidate[] = evidence
    .filter((e) => e && isPrice(e.price) && profileKindOf(e) !== null)
    .map((e) => ({ value: e.price, source: profileKindOf(e) as TargetSource }));

  return [zoneCandidates, scored, profile];
}

/** POC beats VALUE_AREA beats MAX_PAIN when one level carries several. */
function profileKindOf(e: EvidenceLevel): ProfileKind | null {
  if (!Array.isArray(e.kinds)) return null;
  for (const k of PROFILE_KINDS) if (e.kinds.includes(k)) return k;
  return null;
}

/**
 * Spec §3.3. A cap can only ever pull the target CLOSER.
 *
 * The asymmetry is the whole point: the higher timeframe is allowed to say
 * "there is a wall in the way", never "there is more room than you think". A
 * cap that leaves too little reward is handled upstream by the far-edge solve,
 * which collapses the box — the higher timeframe vetoing the trade outright.
 */
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
    case 'ZONE':
      return 'at the next zone';
    case 'EVIDENCE':
      return 'at the next evidence level';
    case 'POC':
      return 'at the point of control';
    case 'VALUE_AREA':
      return 'at the value area edge';
    case 'MAX_PAIN':
      return 'at max pain';
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
