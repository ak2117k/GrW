import type { EvidenceKind, EvidenceLevel, LevelCandidate } from '../types/evidence-level.types';

const FLOOR = 35;

interface ScoreOpts {
  /** Adaptive round-number grid for the soft fallback when a side is empty. */
  softRoundGrid: number[];
  floor?: number;
}

interface Cluster {
  anchor: number;      // first (lowest) candidate's price — never moves; the
                       // tolerance window is anchored here to prevent chain-drift
  price: number;       // strongest contributor's price (representative)
  topScore: number;    // for representative price selection
  score: number;       // summed, capped at 100
  kinds: Set<EvidenceKind>;
}

/**
 * Cluster confluent candidates, sum their evidence into a 0–100 score, side
 * them vs the live price, drop everything below the floor, and — when a side
 * has no kept level — surface the nearest adaptive round number on that side as
 * a `soft` fallback (so a blue-sky breakout still shows a "how far" reference).
 *
 * Candidates are split by side (above/below ltp) BEFORE clustering so a cluster
 * can never straddle the price (which would mis-side it and bury one side's
 * evidence), and each cluster's window is anchored to its first member so a
 * run of candidates can't chain-drift past the tolerance.
 */
export function scoreAndCluster(
  candidates: LevelCandidate[],
  ltp: number,
  atr14: number,
  opts: ScoreOpts,
): EvidenceLevel[] {
  if (!(ltp > 0)) return [];
  const floor = opts.floor ?? FLOOR;
  const tol = Math.max(0.3 * atr14, 0.003 * ltp);

  const valid = candidates.filter(
    (c) => Number.isFinite(c.price) && c.price > 0 && c.price !== ltp,
  );

  // Cluster a single side (all candidates already on one side of ltp). The
  // window is anchored to the cluster's first member, not its shifting
  // representative, so 100/101.5/103 with tol 1.6 does NOT collapse into one.
  const clusterSide = (side: LevelCandidate[]): Cluster[] => {
    const sorted = [...side].sort((a, b) => a.price - b.price);
    const clusters: Cluster[] = [];
    for (const c of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(c.price - last.anchor) <= tol) {
        last.score = Math.min(100, last.score + c.score);
        last.kinds.add(c.kind);
        if (c.score > last.topScore) {
          last.topScore = c.score;
          last.price = c.price;
        }
      } else {
        clusters.push({
          anchor: c.price,
          price: c.price,
          topScore: c.score,
          score: Math.min(100, c.score),
          kinds: new Set([c.kind]),
        });
      }
    }
    return clusters;
  };

  const clusters = [
    ...clusterSide(valid.filter((c) => c.price > ltp)),
    ...clusterSide(valid.filter((c) => c.price < ltp)),
  ];

  const kept: EvidenceLevel[] = clusters
    .filter((cl) => cl.score >= floor)
    .map((cl) => ({
      price: cl.price,
      side: cl.price > ltp ? 'resistance' : 'support',
      score: cl.score,
      kinds: [...cl.kinds],
      soft: false,
      distancePct: ((cl.price - ltp) / ltp) * 100,
    }));

  const hasRes = kept.some((l) => l.side === 'resistance');
  const hasSup = kept.some((l) => l.side === 'support');
  const grid = opts.softRoundGrid.filter((p) => p > 0 && p !== ltp);

  const addSoft = (side: 'resistance' | 'support') => {
    const pool = side === 'resistance' ? grid.filter((p) => p > ltp) : grid.filter((p) => p < ltp);
    if (pool.length === 0) return;
    const price = pool.reduce((best, p) => (Math.abs(p - ltp) < Math.abs(best - ltp) ? p : best));
    kept.push({
      price,
      side,
      score: 0,
      kinds: ['ROUND'],
      soft: true,
      distancePct: ((price - ltp) / ltp) * 100,
    });
  };
  if (!hasRes) addSoft('resistance');
  if (!hasSup) addSoft('support');

  return kept.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
}

/**
 * Keep at most `maxPerSide` non-soft levels per side, ranked by score (desc).
 * Soft fallback levels are always retained — there is at most one per side and
 * it only appears when that side is otherwise empty. The kept levels preserve
 * their input ordering (scoreAndCluster returns nearest-first).
 *
 * Used on native non-15m intervals, where swing-pivot HISTORY candidates
 * over-produce levels and clutter the chart. The frozen 15m path is left
 * uncapped, so its output is unchanged.
 */
export function capLevelsPerSide(levels: EvidenceLevel[], maxPerSide: number): EvidenceLevel[] {
  if (maxPerSide < 0) return levels;
  const keep = new Set<EvidenceLevel>();
  for (const side of ['resistance', 'support'] as const) {
    levels
      .filter((l) => l.side === side && !l.soft)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPerSide)
      .forEach((l) => keep.add(l));
    // Soft fallbacks are always kept regardless of the cap.
    levels.filter((l) => l.side === side && l.soft).forEach((l) => keep.add(l));
  }
  return levels.filter((l) => keep.has(l));
}
