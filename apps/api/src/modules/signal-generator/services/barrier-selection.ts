import type { EvidenceKind, EvidenceLevel } from '../types/evidence-level.types';
import type { StrongZone } from '../types/zone.types';

/**
 * Where the move is actually going — the next HIGH-CONVICTION barrier.
 *
 * See docs/superpowers/specs/2026-08-10-projection-zones-design.md §0.2.
 *
 * The bug this replaces: target selection took the NEAREST opposing level, so a
 * break of ORH targeted the round number 20 points up, and breaking THAT
 * targeted the next one. Every projection was superseded within minutes and
 * none of them described where the move was going — a treadmill. The levels in
 * between are terrain price crosses, not destinations.
 *
 * Everything in this file is pure: no IO, no clock, no DI. It is a projection of
 * what /chart-context has already fetched, which is the property that lets the
 * drawn box and the card's words be the same object.
 */

export type BarrierKind = 'OI_WALL' | 'HVN' | 'VALUE_AREA' | 'MAX_PAIN' | 'ZONE' | 'LEVEL';

export interface Barrier {
  price: number;
  kind: BarrierKind;
  /** 0-100. Why this level is expected to stop price. */
  conviction: number;
  /** One plain sentence naming the evidence, e.g. "24,700 CE open interest". */
  reason: string;
}

export interface SelectBarrierInput {
  /** The break level. A barrier must lie strictly beyond it on the break side. */
  from: number;
  isUp: boolean;
  atr: number;
  zones?: StrongZone[] | null;
  evidence?: EvidenceLevel[] | null;
  /** Anchored levels (PDH/PDL/ORH/ORL/round) — weakest class, see below. */
  levels?: number[] | null;
}

/**
 * Conviction CLASSES, strongest first. The selector picks the nearest barrier
 * WITHIN THE STRONGEST CLASS PRESENT — never the nearest overall.
 *
 * This is the whole fix. If an OI wall sits 180 points ahead and a round number
 * sits 20 points ahead, the round number must lose. Ranking by distance first
 * (or blending distance into the score) reintroduces the treadmill exactly: the
 * closer, weaker level always wins, and the projection restarts the moment
 * price crosses it.
 */
const CLASS_RANK: Record<BarrierKind, number> = {
  OI_WALL: 4,
  HVN: 3,
  VALUE_AREA: 3,
  MAX_PAIN: 3,
  ZONE: 2,
  LEVEL: 1,
};

/**
 * Conviction bands, one per class. The band fixes the ORDERING (a plain level
 * can never out-score an OI wall); the position WITHIN the band is computed
 * from the underlying evidence — OI/evidence score, zone strength and touch
 * count — so two barriers of the same kind are not reported as equally
 * convincing. A number that is constant per class tells a trader nothing.
 */
const BANDS: Record<BarrierKind, { lo: number; hi: number }> = {
  OI_WALL: { lo: 72, hi: 100 },
  HVN: { lo: 48, hi: 70 },
  VALUE_AREA: { lo: 48, hi: 70 },
  MAX_PAIN: { lo: 48, hi: 70 },
  ZONE: { lo: 27, hi: 45 },
  // The fallback class, and precisely the thing that caused the treadmill. It
  // is capped below every evidenced class so the UI can honestly say "nothing
  // strong ahead; this is only an anchored level".
  LEVEL: { lo: 6, hi: 25 },
};

// Bands are deliberately DISJOINT — each floor sits above the band below it.
// If they merely touched, a maximally-evidenced level would tie with a bare
// zone and the UI would present them as equally convincing, which is the same
// mistake as ranking by distance, one layer down.

/**
 * A barrier closer than this many ATR to the break level is noise, not a
 * destination.
 *
 * Justification: the setup's own geometry already spends 0.40 ATR around the
 * break level — BREAKOUT_BODY_ATR (0.15) puts entry past the level and
 * SL_BUFFER_ATR (0.25) puts the stop behind it (see trade-plan.ts). Anything
 * inside that is not somewhere price travels TO; it is inside the noise the
 * trade is already risking through, and a single ordinary bar's excursion
 * consumes it. 0.5 ATR is that spend plus a small margin. Without this filter
 * the nearest round number one tick past the break level qualifies as a target
 * and the projection is superseded on the very next bar — the treadmill's fuel.
 */
const MIN_DISTANCE_ATR = 0.5;

/** Evidence within this many ATR of an anchored level is talking about it. */
const CORROBORATION_ATR = 0.15;

interface Candidate {
  price: number;
  kind: BarrierKind;
  /** 0-1 position within the class band, derived from real evidence. */
  quality: number;
  reason: string;
}

/**
 * The next high-conviction barrier beyond `from`, or null.
 *
 * Null is a legitimate answer — the caller falls back to an ATR-derived target
 * and LABELS it as a fallback. Inventing a barrier here would launder a guess
 * into something the card presents as structure.
 */
export function selectBarrier(input: SelectBarrierInput): Barrier | null {
  const { from, isUp } = input;
  if (!isFiniteNumber(from)) return null;

  // A non-positive or non-finite ATR means we have no scale to judge noise by.
  // Dropping the noise filter is the honest degradation: still require the
  // barrier to be strictly beyond the break, just don't pretend to know what
  // "close" means.
  const atr = isFiniteNumber(input.atr) && input.atr > 0 ? input.atr : 0;
  const minGap = MIN_DISTANCE_ATR * atr;

  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const candidates: Candidate[] = [
    ...oiWallCandidates(evidence, isUp),
    ...profileCandidates(evidence),
    ...zoneCandidates(Array.isArray(input.zones) ? input.zones : [], isUp),
    ...levelCandidates(Array.isArray(input.levels) ? input.levels : [], evidence, atr),
  ];

  const ahead = candidates.filter((c) => {
    if (!isFiniteNumber(c.price) || c.price <= 0) return false;
    // Strictly beyond the break, on the break side. A "barrier" behind price is
    // structure it has already resolved.
    if (isUp ? c.price <= from : c.price >= from) return false;
    return Math.abs(c.price - from) >= minGap;
  });
  if (ahead.length === 0) return null;

  // Strongest class present, then nearest within it.
  const bestRank = ahead.reduce((r, c) => Math.max(r, CLASS_RANK[c.kind]), 0);
  const inClass = ahead.filter((c) => CLASS_RANK[c.kind] === bestRank);
  const winner = inClass.reduce((best, c) =>
    Math.abs(c.price - from) < Math.abs(best.price - from) ? c : best,
  );

  return {
    price: winner.price,
    kind: winner.kind,
    conviction: convictionFor(winner),
    reason: winner.reason,
  };
}

/** Band floor plus the evidence-derived fraction of the band's width. */
function convictionFor(c: Candidate): number {
  const band = BANDS[c.kind];
  const q = clamp01(c.quality);
  return Math.round(band.lo + q * (band.hi - band.lo));
}

/**
 * Class 1 — the option-chain wall. For an index the largest CE OI above spot is
 * the practical ceiling and the largest PE OI below is the floor: it is where
 * writers have money committed to price NOT going, which is a stronger claim
 * than any price-history level makes.
 *
 * Direction matters. CE OI is a ceiling, so it only bars an UP move; PE OI only
 * bars a DOWN move. OI_CHANGE is fresh positioning on either side and counts
 * both ways.
 */
function oiWallCandidates(evidence: EvidenceLevel[], isUp: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const e of evidence) {
    if (!e || !Array.isArray(e.kinds)) continue;
    const directional: EvidenceKind = isUp ? 'OI_CALL' : 'OI_PUT';
    const hasWall = e.kinds.includes(directional);
    const hasChange = e.kinds.includes('OI_CHANGE');
    if (!hasWall && !hasChange) continue;

    const score = normScore(e.score);
    out.push({
      price: e.price,
      kind: 'OI_WALL',
      quality: score,
      reason: hasWall
        ? `${fmt(e.price)} carries the heaviest ${isUp ? 'call' : 'put'} open interest ahead (evidence score ${Math.round(clampScore(e.score))}).`
        : `${fmt(e.price)} is where open interest has been building today (evidence score ${Math.round(clampScore(e.score))}).`,
    });
  }
  return out;
}

/**
 * Class 2 — volume structure. Price traverses low-volume nodes fast and stalls
 * where volume was actually transacted, so a POC / value-area edge / max-pain
 * strike is a real destination in a way a round number is not.
 */
function profileCandidates(evidence: EvidenceLevel[]): Candidate[] {
  const out: Candidate[] = [];
  for (const e of evidence) {
    if (!e || !Array.isArray(e.kinds)) continue;
    const kind: BarrierKind | null = e.kinds.includes('POC')
      ? 'HVN'
      : e.kinds.includes('VALUE_AREA')
        ? 'VALUE_AREA'
        : e.kinds.includes('MAX_PAIN')
          ? 'MAX_PAIN'
          : null;
    if (kind === null) continue;

    const score = Math.round(clampScore(e.score));
    const what =
      kind === 'HVN'
        ? 'the high-volume node'
        : kind === 'VALUE_AREA'
          ? 'the value-area edge'
          : 'max pain';
    out.push({
      price: e.price,
      kind,
      quality: normScore(e.score),
      reason: `${fmt(e.price)} is ${what} for this session (evidence score ${score}).`,
    });
  }
  return out;
}

/**
 * Class 3 — a zone with real touch history. STRONG/MEDIUM and touchCount >= 3,
 * the same gate obstacle-aware TP1 uses in trade-plan.ts: below three touches
 * the "zone" is two coincidences and price has not demonstrably respected it.
 *
 * Near edge is what price reaches first — `lower` climbing into it, `upper`
 * falling into it — so that is the barrier price, not the zone's midpoint.
 */
function zoneCandidates(zones: StrongZone[], isUp: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const z of zones) {
    if (!z) continue;
    if (z.classification !== 'STRONG' && z.classification !== 'MEDIUM') continue;
    if (!(z.touchCount >= 3)) continue;

    const nearEdge = isUp ? z.lower : z.upper;
    // Quality blends the two things that make a zone credible: how strong the
    // detector scored it, and how many times price actually turned there.
    // Touches saturate at 8 — the tenth touch is not twice the ninth.
    const touchQ = Math.min(z.touchCount, 8) / 8;
    const strengthQ = normScore(z.strength);
    out.push({
      price: nearEdge,
      kind: 'ZONE',
      quality: 0.5 * strengthQ + 0.5 * touchQ,
      reason: `${fmt(nearEdge)} is the near edge of a ${z.classification.toLowerCase()} zone price has turned at ${z.touchCount} times.`,
    });
  }
  return out;
}

/**
 * Class 4 — a plain anchored level. FALLBACK ONLY.
 *
 * This is exactly what produced the treadmill: a round number nobody has traded
 * against is not a barrier. It stays in the candidate set because a chart with
 * only levels drawn on it should still project something, but it must be the
 * weakest class and it must be reported as such.
 *
 * Its conviction is not a constant either: where an evidence cluster sits on
 * top of the level, the level inherits a fraction of that cluster's score. A
 * bare level with nothing corroborating it stays at the band floor, which is
 * the honest reading.
 */
function levelCandidates(
  levels: number[],
  evidence: EvidenceLevel[],
  atr: number,
): Candidate[] {
  const tolerance = CORROBORATION_ATR * atr;
  const out: Candidate[] = [];
  for (const price of levels) {
    if (!isFiniteNumber(price)) continue;
    let corroboration = 0;
    if (tolerance > 0) {
      for (const e of evidence) {
        if (!e || !isFiniteNumber(e.price)) continue;
        if (Math.abs(e.price - price) > tolerance) continue;
        corroboration = Math.max(corroboration, normScore(e.score));
      }
    }
    out.push({
      price,
      kind: 'LEVEL',
      quality: corroboration,
      reason:
        corroboration > 0
          ? `${fmt(price)} is an anchored level with some evidence behind it — the weakest kind of barrier, used because nothing stronger lies ahead.`
          : `${fmt(price)} is only an anchored level with no evidence behind it — the weakest kind of barrier, used because nothing stronger lies ahead.`,
    });
  }
  return out;
}

function normScore(v: unknown): number {
  return clampScore(v) / 100;
}

function clampScore(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Indian-style grouping, e.g. 24700 -> "24,700". Deterministic, no Intl. */
function fmt(v: number): string {
  const neg = v < 0;
  const abs = Math.abs(v);
  const whole = Math.trunc(abs);
  const frac = abs - whole;
  const s = String(whole);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  const tail = frac > 0 ? frac.toFixed(2).slice(1) : '';
  return `${neg ? '-' : ''}${grouped}${tail}`;
}
