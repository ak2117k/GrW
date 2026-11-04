import { ENTRY_ENGINE, impactConcerns, type Direction, type ImpactRow } from './entry-decision';

/**
 * NEWS THEME SCORE (owner 2026-11-02). Prod 2 Nov: crude fell ~350–400 pts on a weekend of US–Iran
 * diplomacy news. The model read every story BEAR LOW / NEUTRAL LOW — none "material" — so the
 * engine's per-story rule (a MED/HIGH story, or a material cluster) never fired, though five
 * separate outlets were saying "oil falls" within three hours.
 *
 * A THEME is several distinct stories from several outlets pointing the same way inside a window.
 * Each story keeps the engine's own weight (magnitude × confidence × priced-in factor, from
 * {@link ENTRY_ENGINE}) times a recency decay. The theme is MATERIAL when
 *   ≥ minStories distinct same-side stories, from ≥ minSources distinct sources,
 *   |net decayed score| ≥ minNet, and the side carries ≥ minSideShare of the directional weight
 * — even when every story is LOW. Pure: no I/O, no clock.
 *
 * MATCHING is wider than the per-story rule (impactConcerns): besides the impact's own symbols /
 * index / sectors, a story counts INDIRECTLY when the model named no other target (no symbols, no
 * index) and the story is about the underlying by its sector tag (e.g. 'MCX ENERGY'), its cluster
 * instruments, or its headline (crude: oil / crude / Brent / WTI / OPEC, minus company names like
 * "Indian Oil"). An impact aimed at another target (e.g. OMC stocks, or the NIFTY index) keeps its
 * direction for THAT target and is not read as a crude call.
 */

export const NEWS_THEME = Object.freeze({
  /** Intraday (entry engine): impacts read in the last 3 h, half-life 3 h. */
  intraday: Object.freeze({ windowMin: 180, halfLifeMin: 180 }),
  /** Pre-open: impacts read in the last 24 h at least (back to the last close, ≤ 72 h), half-life 12 h. */
  preOpen: Object.freeze({ windowMin: 24 * 60, halfLifeMin: 12 * 60, maxWindowMin: 72 * 60 }),
  /** Distinct same-side stories (clusters) needed. */
  minStories: 4,
  /** Distinct sources across those stories. */
  minSources: 2,
  /** |net decayed score| needed (4 fresh LOW stories at 0.4 confidence = 0.40; half-decayed = 0.20). */
  minNet: 0.2,
  /** The theme's side must carry this share of the total directional (|weight|) score. */
  minSideShare: 0.7,
  /** Below this |net| the theme has no lean at all. */
  leanNet: 0.1,
});

export interface ThemeWindow {
  windowMin: number;
  halfLifeMin: number;
}

export type ThemeMatch = 'DIRECT' | 'SECTOR' | 'INSTRUMENT' | 'HEADLINE';

export interface ThemeItem {
  clusterId: string;
  direction: string;
  magnitude: string;
  confidence: number;
  match: ThemeMatch;
  /** Signed, decayed weight (+ bullish). */
  weight: number;
  ageMin: number;
  sources: string[];
  headline: string;
}

export interface NewsTheme {
  /** The side the theme leans (|net| ≥ leanNet), else null. */
  side: Direction | null;
  material: boolean;
  /** Distinct stories on the side / against it / neutral. */
  stories: number;
  against: number;
  neutral: number;
  /** Distinct sources across the side's stories. */
  sources: number;
  net: number;
  sideShare: number;
  windowMin: number;
  items: ThemeItem[];
  /** Why it is (not) material, one line. */
  summary: string;
}

const MIN = 60_000;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Story subjects by headline, per underlying (indirect matching only). */
/** `include` names the subject; `exclude` drops look-alikes unless `rescue` also matches. */
const HEADLINE_SUBJECT: Readonly<Record<string, { include: RegExp; exclude: RegExp | null; rescue?: RegExp }>> = Object.freeze({
  CRUDEOIL: {
    include: /\b(crude|brent|wti|opec\+?|oil)\b/i,
    // Company / product names that contain "oil" but are not about the crude price.
    exclude: /\b(indian oil|oil india|gulf oil|kirloskar oil|oil (&|and) natural gas|palm oil|edible oil|vegetable oil|oil-to-chemicals|oil engines|castor oil)\b/i,
    rescue: /\b(crude|brent|wti|opec)\b/i,
  },
  NIFTY: { include: /\b(nifty|sensex|d-street|dalal street|indian (equities|stocks|shares|markets?))\b/i, exclude: /\bbank nifty\b/i },
  SENSEX: { include: /\b(sensex|nifty|d-street|dalal street)\b/i, exclude: null },
  BANKNIFTY: { include: /\b(bank nifty|banknifty|nifty bank|psu banks?|private banks?)\b/i, exclude: null },
  // 2026-11-04: bullion. Gold-loan lenders, jewellers, 'golden', gold bonds / ETFs are companies or
  // products, not the metal's price — unless the headline also names the price (Comex, bullion, 'gold prices').
  GOLD: {
    include: /\b(gold|bullion|yellow metal|comex gold)\b/i,
    exclude: /\b(muthoot|manappuram|gold loans?|gold finance|gold bonds?|sovereign gold|gold etfs?|golden|kalyan|titan|senco|gold medals?|gold standard)\b/i,
    rescue: /\b(comex|bullion|yellow metal|gold (prices?|rates?|futures)|mcx gold|spot gold)\b/i,
  },
  SILVER: {
    include: /\b(silver|comex silver)\b/i,
    exclude: /\b(silver (lining|jubilee|screen|medals?|oak)|silverline|silver spoon)\b/i,
    rescue: /\b(comex|bullion|silver (prices?|rates?|futures)|mcx silver|spot silver)\b/i,
  },
});

/** Is the headline about the underlying's own market (crude: oil / crude / Brent / WTI / OPEC, not "Indian Oil")? */
export function headlineAbout(underlying: string, headline: string): boolean {
  const head = HEADLINE_SUBJECT[underlying.toUpperCase()];
  if (!head || !head.include.test(headline)) return false;
  return !(head.exclude && head.exclude.test(headline) && !(head.rescue && head.rescue.test(headline)));
}

/** Sector tags the model uses for the underlying's own market. */
const SUBJECT_SECTORS: Readonly<Record<string, string[]>> = Object.freeze({
  CRUDEOIL: ['MCX ENERGY'],
  BANKNIFTY: ['NIFTY BANK'],
  GOLD: ['MCX BULLION'],
  SILVER: ['MCX BULLION'],
});

/** Cluster instruments that name the underlying itself. */
const SUBJECT_INSTRUMENTS: Readonly<Record<string, string[]>> = Object.freeze({
  CRUDEOIL: ['CRUDEOIL', 'CRUDEOILM'],
  GOLD: ['GOLD', 'GOLDM'],
  SILVER: ['SILVER', 'SILVERM'],
  NIFTY: ['NIFTY'],
  SENSEX: ['SENSEX'],
  BANKNIFTY: ['BANKNIFTY'],
});

/** How (if at all) one impact concerns the underlying for the theme. */
export function themeMatch(underlying: string, r: Pick<ImpactRow, 'symbols' | 'sectors' | 'indexName' | 'headline'> & { instruments?: string[] }): ThemeMatch | null {
  if (impactConcerns(underlying, r)) return 'DIRECT';
  const u = underlying.toUpperCase();
  // The model aimed this read at another target: its direction is for that target, not ours.
  if ((r.symbols ?? []).length > 0 || r.indexName !== null) return null;
  const up = (xs: readonly string[] | undefined) => (xs ?? []).map((x) => String(x).toUpperCase());
  if (up(r.sectors).some((s) => (SUBJECT_SECTORS[u] ?? []).includes(s))) return 'SECTOR';
  const aboutByHeadline = headlineAbout(u, r.headline);
  if (up(r.instruments).some((s) => (SUBJECT_INSTRUMENTS[u] ?? [u]).includes(s)) && aboutByHeadline) return 'INSTRUMENT';
  if (aboutByHeadline) return 'HEADLINE';
  return null;
}

/** Signed, undecayed engine weight of one impact (+ bullish): magnitude × confidence × priced-in factor. */
export function impactWeight(r: Pick<ImpactRow, 'direction' | 'magnitude' | 'confidence' | 'pricedIn'>): number {
  const dir = String(r.direction).toUpperCase();
  const sign = dir === 'BULL' ? 1 : dir === 'BEAR' ? -1 : 0;
  return sign * (ENTRY_ENGINE.newsMagnitudeWeight[String(r.magnitude).toUpperCase()] ?? 0) * r.confidence * (r.pricedIn ? ENTRY_ENGINE.newsPricedInFactor : 1);
}

/**
 * The theme for `underlying` at `at`: impacts the model READ in (at − window, at] (no look-ahead),
 * confidence ≥ the engine minimum, one row per cluster (the latest read), decayed by the story's age
 * (since first seen) with the window's half-life.
 */
export function newsTheme(impacts: readonly ImpactRow[], underlying: string, at: Date, w: ThemeWindow = NEWS_THEME.intraday): NewsTheme {
  const t = at.getTime();
  const from = t - w.windowMin * MIN;
  const byCluster = new Map<string, { r: ImpactRow; match: ThemeMatch }>();
  for (const r of impacts) {
    const a = r.analysedAt.getTime();
    if (!(a > from && a <= t)) continue;
    if (!(r.confidence >= ENTRY_ENGINE.newsMinConfidence)) continue;
    const match = themeMatch(underlying, r);
    if (!match) continue;
    const prev = byCluster.get(r.clusterId);
    if (!prev || prev.r.analysedAt.getTime() < a) byCluster.set(r.clusterId, { r, match });
  }
  const items: ThemeItem[] = [...byCluster.values()]
    .map(({ r, match }) => {
      const ageMin = Math.max(0, (t - r.firstSeen.getTime()) / MIN);
      const decay = Math.pow(0.5, ageMin / Math.max(1, w.halfLifeMin));
      return {
        clusterId: r.clusterId,
        direction: String(r.direction).toUpperCase(),
        magnitude: String(r.magnitude).toUpperCase(),
        confidence: r.confidence,
        match,
        weight: r4(impactWeight(r) * decay),
        ageMin: Math.round(ageMin),
        sources: r.sources && r.sources.length > 0 ? [...r.sources] : [`cluster:${r.clusterId}`],
        headline: r.headline.slice(0, 160),
      };
    })
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || a.ageMin - b.ageMin);

  const net = r4(items.reduce((s, i) => s + i.weight, 0));
  const total = items.reduce((s, i) => s + Math.abs(i.weight), 0);
  const side: Direction | null = net >= NEWS_THEME.leanNet ? 'BULLISH' : net <= -NEWS_THEME.leanNet ? 'BEARISH' : null;
  const sideDir = side === 'BULLISH' ? 'BULL' : side === 'BEARISH' ? 'BEAR' : null;
  const onSide = items.filter((i) => sideDir !== null && i.direction === sideDir);
  const against = items.filter((i) => sideDir !== null && i.direction !== 'NEUTRAL' && i.direction !== sideDir).length;
  const neutral = items.filter((i) => i.direction === 'NEUTRAL').length;
  const sources = new Set(onSide.flatMap((i) => i.sources.map((s) => s.trim().toLowerCase()))).size;
  const sideShare = total > 0 && side ? r4(onSide.reduce((s, i) => s + Math.abs(i.weight), 0) / total) : 0;

  const fails: string[] = [];
  if (!side) fails.push(`net ${net} has no lean (|net| < ${NEWS_THEME.leanNet})`);
  else {
    if (onSide.length < NEWS_THEME.minStories) fails.push(`${onSide.length} ${sideDir} stor${onSide.length === 1 ? 'y' : 'ies'} (< ${NEWS_THEME.minStories})`);
    if (sources < NEWS_THEME.minSources) fails.push(`${sources} source(s) (< ${NEWS_THEME.minSources})`);
    if (Math.abs(net) < NEWS_THEME.minNet) fails.push(`|net| ${Math.abs(net)} < ${NEWS_THEME.minNet}`);
    if (sideShare < NEWS_THEME.minSideShare) fails.push(`side share ${sideShare} < ${NEWS_THEME.minSideShare} (mixed)`);
  }
  const material = side !== null && fails.length === 0;
  const head = `${items.length} stor${items.length === 1 ? 'y' : 'ies'} in ${Math.round(w.windowMin / 60)} h`;
  const summary = side
    ? `theme ${side.toLowerCase()} net ${net}: ${onSide.length} ${sideDir} / ${against} against / ${neutral} neutral, ${sources} source(s), share ${sideShare} — ${head}${material ? ' (material)' : `; not material: ${fails.join(', ')}`}`
    : `theme none — ${head}; ${fails.join(', ')}`;
  return { side, material, stories: onSide.length, against, neutral, sources, net, sideShare, windowMin: w.windowMin, items, summary };
}
