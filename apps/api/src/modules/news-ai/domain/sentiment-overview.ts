import type { Direction } from './news-ai.schemas';
import type { ReadArticle } from './news-ai.inputs';

export interface DirectionCounts {
  BULL: number;
  BEAR: number;
  NEUTRAL: number;
  MIXED: number;
}

export interface OverviewGroup {
  name: string;
  /** Articles that name this instrument in `affected` (per direction). */
  counts: { BULL: number; BEAR: number };
  /** -100 (all bearish) .. +100 (all bullish), weighted by importance x strength. */
  score: number;
  label: 'BULL' | 'BEAR' | 'NEUTRAL';
  /** Up to 5 article ids with the most weight, for drill-down. */
  articleIds: string[];
}

export interface SentimentOverview {
  hours: number;
  from: string;
  to: string;
  total: number;
  overall: {
    counts: DirectionCounts;
    score: number;
    label: 'BULL' | 'BEAR' | 'NEUTRAL';
    /** Mean importance of the reads in the window. */
    avgImportance: number;
  };
  indices: OverviewGroup[];
  sectors: OverviewGroup[];
  commodities: OverviewGroup[];
}

const SIGN: Record<Direction, number> = { BULL: 1, BEAR: -1, NEUTRAL: 0, MIXED: 0 };
/** A score inside +/- this band reads NEUTRAL. */
const NEUTRAL_BAND = 15;

/** One article's weight: importance x strength, both 0-100, as 0..1 (a floor keeps zero-strength reads counted). */
export const weightOf = (r: Pick<ReadArticle, 'importance' | 'strength'>) => Math.max(0.01, (r.importance / 100) * (r.strength / 100));

const labelOf = (score: number): 'BULL' | 'BEAR' | 'NEUTRAL' => (score >= NEUTRAL_BAND ? 'BULL' : score <= -NEUTRAL_BAND ? 'BEAR' : 'NEUTRAL');

const INDEX_ALIASES: Record<string, string> = {
  'NIFTY 50': 'NIFTY',
  NIFTY50: 'NIFTY',
  'NIFTY BANK': 'BANKNIFTY',
  'BANK NIFTY': 'BANKNIFTY',
  'BSE SENSEX': 'SENSEX',
  'NIFTY FIN SERVICE': 'FINNIFTY',
  'NIFTY FINANCIAL SERVICES': 'FINNIFTY',
  'NIFTY MIDCAP SELECT': 'MIDCPNIFTY',
};
const COMMODITY_ALIASES: Record<string, string> = {
  CRUDE: 'CRUDEOIL',
  'CRUDE OIL': 'CRUDEOIL',
  BRENT: 'CRUDEOIL',
  WTI: 'CRUDEOIL',
  OIL: 'CRUDEOIL',
  'NATURAL GAS': 'NATURALGAS',
  NATGAS: 'NATURALGAS',
};

export const canonicalIndex = (n: string) => INDEX_ALIASES[n] ?? n.replace(/\s+/g, '');
export const canonicalCommodity = (n: string) => COMMODITY_ALIASES[n] ?? n.replace(/\s+/g, '');
const canonicalSector = (n: string) => n.replace(/[\s-]+/g, '_');

function groups(reads: readonly ReadArticle[], kind: string, canon: (n: string) => string, pinned: readonly string[]): OverviewGroup[] {
  const acc = new Map<string, { bull: number; bear: number; num: number; den: number; arts: Array<[string, number]> }>();
  for (const n of pinned) acc.set(n, { bull: 0, bear: 0, num: 0, den: 0, arts: [] });
  for (const r of reads) {
    const w = weightOf(r);
    const seen = new Set<string>();
    for (const a of r.affected) {
      if (a.kind !== kind) continue;
      const name = canon(a.name);
      if (seen.has(name)) continue;
      seen.add(name);
      const g = acc.get(name) ?? { bull: 0, bear: 0, num: 0, den: 0, arts: [] };
      if (a.direction === 'BULL') g.bull++;
      else g.bear++;
      g.num += (a.direction === 'BULL' ? 1 : -1) * w;
      g.den += w;
      g.arts.push([r.id, w]);
      acc.set(name, g);
    }
  }
  return [...acc.entries()]
    .map(([name, g]) => {
      const score = g.den > 0 ? Math.round((g.num / g.den) * 100) : 0;
      return {
        name,
        counts: { BULL: g.bull, BEAR: g.bear },
        score,
        label: labelOf(score),
        articleIds: g.arts.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id),
        weight: g.den,
      };
    })
    .sort((a, b) => {
      const pa = pinned.indexOf(a.name);
      const pb = pinned.indexOf(b.name);
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
      return b.weight - a.weight;
    })
    .map(({ weight: _w, ...g }) => g);
}

/** Aggregate AI reads into the page's sentiment overview (pure). */
export function sentimentOverview(reads: readonly ReadArticle[], hours: number, now: Date): SentimentOverview {
  const counts: DirectionCounts = { BULL: 0, BEAR: 0, NEUTRAL: 0, MIXED: 0 };
  let num = 0;
  let den = 0;
  let imp = 0;
  for (const r of reads) {
    counts[r.direction]++;
    const w = weightOf(r);
    num += SIGN[r.direction] * w;
    den += w;
    imp += r.importance;
  }
  const score = den > 0 ? Math.round((num / den) * 100) : 0;
  return {
    hours,
    from: new Date(now.getTime() - hours * 3_600_000).toISOString(),
    to: now.toISOString(),
    total: reads.length,
    overall: { counts, score, label: labelOf(score), avgImportance: reads.length ? Math.round(imp / reads.length) : 0 },
    indices: groups(reads, 'INDEX', canonicalIndex, ['NIFTY', 'BANKNIFTY', 'SENSEX']),
    sectors: groups(reads, 'SECTOR', canonicalSector, []),
    commodities: groups(reads, 'COMMODITY', canonicalCommodity, ['CRUDEOIL', 'GOLD', 'SILVER']),
  };
}
