import type { StrongZone } from '@/types';

export type ZoneTier = 'immediate' | 'major' | 'context' | 'forming';

export interface ZoneTierAnnotation {
  zone: StrongZone;
  tier: ZoneTier;
  /** True when this is the nearest drawable zone on its side of the LTP. */
  isImmediate: boolean;
  /** True when this is the nearest STRONG zone on its side of the LTP. */
  isMajor: boolean;
  /** The band edge price reaches first coming from the LTP (== center for lines). */
  refPrice: number;
  /** Signed % distance from LTP. + = above price, - = below. */
  distancePct: number;
}

/** The band edge a mover reaches first coming from the LTP side. */
function refPriceFor(zone: StrongZone): number {
  if (zone.isLine) return zone.upper; // upper === lower for a line
  // Resistance sits above price → its LOWER edge is hit first.
  // Support sits below price → its UPPER edge is hit first.
  return zone.type === 'resistance' ? zone.lower : zone.upper;
}

/**
 * Annotate strong zones into trader tiers relative to the live price:
 *  - immediate = nearest drawable zone on each side (the next wall)
 *  - major     = nearest STRONG zone on each side (the structural wall)
 *  - forming   = a freshly-flipped (flippedAt != null) zone still demoted to
 *                WEAK — the breakout origin; drawn dotted, excluded from the
 *                immediate/major competition so it can't steal those tiers.
 * A zone can be both immediate and major (nearest is STRONG) — `tier` is
 * 'immediate' but `isMajor` is also true so the renderer can tag it `IMM·MAJOR`.
 *
 * Non-flipped WEAK zones are dropped (genuine noise). A flipped zone that has
 * earned MEDIUM/STRONG again (3+ retests) goes through the normal tiering, not
 * `forming`. Returns [] when ltp is not a positive number.
 */
export function classifyZoneTiers(
  zones: StrongZone[],
  ltp: number,
): ZoneTierAnnotation[] {
  if (!Number.isFinite(ltp) || ltp <= 0) return [];

  // Keep non-WEAK zones AND freshly-flipped (forming) zones — a flipped level
  // is the breakout origin and the most relevant level on a moving stock, even
  // while the detector demotes it to WEAK until 3+ retests. Still drop
  // non-flipped WEAK (genuine noise) and straddle bands.
  const drawable = zones.filter(
    (z) =>
      (z.classification !== 'WEAK' || z.flippedAt != null) &&
      (z.isLine || z.lower > ltp || z.upper < ltp),
  );

  // Forming (flipped + WEAK) zones get their own tier and are excluded from the
  // immediate/major competition so they don't steal those tiers from proven
  // zones. They still render (dotted) so a breakout's flipped level is visible.
  const forming: StrongZone[] = [];
  const above: StrongZone[] = [];
  const below: StrongZone[] = [];
  for (const z of drawable) {
    if (z.classification === 'WEAK' && z.flippedAt != null) {
      forming.push(z);
      continue;
    }
    const ref = refPriceFor(z);
    if (ref > ltp) above.push(z);
    else below.push(z); // ref <= ltp → treat as support side deterministically
  }
  const formingAnnotations: ZoneTierAnnotation[] = forming.map((zone) => {
    const refPrice = refPriceFor(zone);
    return {
      zone,
      tier: 'forming',
      isImmediate: false,
      isMajor: false,
      refPrice,
      distancePct: ((refPrice - ltp) / ltp) * 100,
    };
  });

  const annotateSide = (side: StrongZone[]): ZoneTierAnnotation[] => {
    if (side.length === 0) return [];
    type Row = {
      zone: StrongZone;
      refPrice: number;
      distancePct: number;
      absDist: number; // sort-only; never returned
    };
    const rows: Row[] = side.map((zone) => {
      const refPrice = refPriceFor(zone);
      return {
        zone,
        refPrice,
        distancePct: ((refPrice - ltp) / ltp) * 100,
        absDist: Math.abs(refPrice - ltp),
      };
    });

    // Nearest wins `immediate`. Strict `<` means ties are won by the
    // first-in-input-array zone; the equidistant other falls to major/context.
    let nearestIdx = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].absDist < rows[nearestIdx].absDist) nearestIdx = i;
    }

    let strongIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].zone.classification !== 'STRONG') continue;
      if (strongIdx === -1 || rows[i].absDist < rows[strongIdx].absDist) {
        strongIdx = i;
      }
    }

    return rows.map((d, i) => {
      const isImmediate = i === nearestIdx;
      const isMajor = i === strongIdx;
      const tier: ZoneTier = isImmediate
        ? 'immediate'
        : isMajor
          ? 'major'
          : 'context';
      return {
        zone: d.zone,
        tier,
        isImmediate,
        isMajor,
        refPrice: d.refPrice,
        distancePct: d.distancePct,
      };
    });
  };

  return [...annotateSide(above), ...annotateSide(below), ...formingAnnotations];
}
