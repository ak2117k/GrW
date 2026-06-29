import type { EvidenceLevel, StrongZone } from '@/types';

export type SRSource = 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'VWAP' | 'PIVOT' | 'EVIDENCE';
export type SRTier = 'immediate' | 'major' | 'context' | 'soft';

export interface SRLevel {
  price: number;
  side: 'resistance' | 'support';
  source: SRSource;
  label: string;
  tier: SRTier;
  distancePct: number;
  classification?: 'STRONG' | 'MEDIUM' | 'WEAK';
}

export interface SRView {
  immediateResistance: SRLevel | null;
  immediateSupport: SRLevel | null;
  levels: SRLevel[];
}

/** Minimal level-book shape (structurally satisfied by AnalysisDto.levels). */
export interface LevelBookLite {
  pdh: number | null;
  pdl: number | null;
  orh: number | null;
  orl: number | null;
  prevOrh?: number | null;
  prevOrl?: number | null;
  vwap: number;
}

const DEDUPE_EPS_PCT = 0.05; // 0.05% — treat anchored & pivot within this as one

/** Pivot reachable edge: resistance hits its lower edge first, support its upper. */
function pivotRefPrice(z: StrongZone): number {
  if (z.isLine) return z.upper;
  return z.type === 'resistance' ? z.lower : z.upper;
}

interface Candidate {
  price: number;
  source: SRSource;
  label: string;
  isStructural: boolean; // STRONG pivot, or PDH/PDL — eligible for `major`
  classification?: 'STRONG' | 'MEDIUM' | 'WEAK';
  isSoft?: boolean;
  evScore?: number;
}

export function buildSRView(
  book: LevelBookLite | null,
  zones: StrongZone[],
  evidence: EvidenceLevel[],
  ltp: number,
): SRView {
  if (!Number.isFinite(ltp) || ltp <= 0) {
    return { immediateResistance: null, immediateSupport: null, levels: [] };
  }

  const candidates: Candidate[] = [];

  if (book) {
    const push = (price: number | null | undefined, source: SRSource, label: string, structural: boolean) => {
      if (price != null && price > 0) candidates.push({ price, source, label, isStructural: structural });
    };
    push(book.pdh, 'PDH', 'PDH', true);
    push(book.pdl, 'PDL', 'PDL', true);
    // Treat a 0/negative orh/orl as "not locked yet" and fall back to the
    // previous session's OR (some feeds send 0 as a not-set sentinel, which
    // `??` would not catch).
    push(book.orh && book.orh > 0 ? book.orh : book.prevOrh, 'ORH', 'ORH', false);
    push(book.orl && book.orl > 0 ? book.orl : book.prevOrl, 'ORL', 'ORL', false);
    if (book.vwap > 0) push(book.vwap, 'VWAP', 'VWAP', false);
  }

  for (const z of zones) {
    const hasFlipped = z.flippedAt != null;
    if (z.classification === 'WEAK' && !hasFlipped) continue;
    // Skip straddle bands (range contains ltp) — same guard classifyZoneTiers
    // uses. The reachable edge would land on one side and misrepresent a band
    // the price is sitting inside.
    if (!z.isLine && z.lower <= ltp && z.upper >= ltp) continue;
    candidates.push({
      price: pivotRefPrice(z),
      source: 'PIVOT',
      label: `S${z.strength}`,
      isStructural: z.classification === 'STRONG',
      classification: z.classification,
    });
  }

  // Evidence-weighted levels (volume nodes, OI walls, round confluence, soft
  // fallbacks) arrive pre-scored and pre-sided from the backend.
  for (const e of evidence) {
    candidates.push({
      price: e.price,
      source: 'EVIDENCE',
      label: e.soft ? 'ROUND' : e.kinds[0] ?? 'EVIDENCE',
      isStructural: !e.soft && e.score >= 60,
      isSoft: e.soft,
      evScore: e.score,
    });
  }

  const above: Candidate[] = [];
  const below: Candidate[] = [];
  for (const c of candidates) {
    if (c.price > ltp) above.push(c);
    else if (c.price < ltp) below.push(c);
  }

  // Dedupe within a side at the eps window, with anchored levels winning over
  // pivots: keep all non-conflicting anchored levels first, then add pivots
  // only where they don't sit within eps of an already-kept anchored level — so
  // a pivot on top of (or just nearer than) PDH/VWAP collapses into the
  // anchored level, which carries the more meaningful label. Re-sort the merged
  // result by distance so `immediate` (nearest) still picks correctly.
  const eps = (ltp * DEDUPE_EPS_PCT) / 100;
  const byDistance = (a: Candidate, b: Candidate) =>
    Math.abs(a.price - ltp) - Math.abs(b.price - ltp);
  const dedupe = (arr: Candidate[]): Candidate[] => {
    const anchored = arr.filter((c) => c.source !== 'PIVOT').sort(byDistance);
    const pivots = arr.filter((c) => c.source === 'PIVOT').sort(byDistance);
    const kept: Candidate[] = [];
    for (const c of [...anchored, ...pivots]) {
      if (kept.some((k) => Math.abs(k.price - c.price) <= eps)) continue;
      kept.push(c);
    }
    return kept.sort(byDistance);
  };
  const aboveKept = dedupe(above);
  const belowKept = dedupe(below);

  const toLevel = (
    c: Candidate,
    side: 'resistance' | 'support',
    isImmediate: boolean,
  ): SRLevel => {
    const tier: SRTier = c.isSoft
      ? 'soft'
      : isImmediate
        ? 'immediate'
        : c.isStructural
          ? 'major'
          : 'context';
    return {
      price: c.price,
      side,
      source: c.source,
      label: c.label,
      tier,
      distancePct: ((c.price - ltp) / ltp) * 100,
      classification: c.classification,
    };
  };

  const resLevels = aboveKept.map((c, i) => toLevel(c, 'resistance', i === 0));
  const supLevels = belowKept.map((c, i) => toLevel(c, 'support', i === 0));

  return {
    immediateResistance: resLevels[0] ?? null,
    immediateSupport: supLevels[0] ?? null,
    levels: [...resLevels, ...supLevels],
  };
}
