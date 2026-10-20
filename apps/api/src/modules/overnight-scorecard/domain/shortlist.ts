/**
 * The news-ideas shortlist (design §4): F&O-eligible, strong news (|sentiment| strong, or a
 * material NSE announcement), not already held, at most 5 per batch, strongest first.
 */
import { NSE_ANNOUNCEMENTS_SOURCE, newsStrength } from './factors';

export const SHORTLIST_CAP = 5;
/** |weighted sentiment| at or above this is "strong" news. */
export const STRONG_NEWS = 0.5;

/** NSE announcement types that move a stock; routine filings never qualify. */
export const MATERIAL_ANNOUNCEMENT =
  /\b(financial results?|results|acquisition|acquire|merger|amalgamation|demerger|order|contract|award|buy-?back|bonus|stock split|sub-division|dividend|fund ?raising|qip|preferential|rights issue|credit rating|downgrade|upgrade|resignation|insolvency|default|fraud|search|raid|penalty|approval|usfda|warning letter|import alert|block deal|bulk deal|stake)\b/i;
export const ROUTINE_ANNOUNCEMENT =
  /\b(trading window|newspaper publication|analysts?\/institutional investor meet|loss of share certificate|compliance certificate|certificate under reg|regulation 74|duplicate share|change in registrar|investor presentation|closure of trading window)\b/i;

export interface CandidateArticle {
  id: string;
  title: string;
  url: string;
  source: string;
  sentiment: string | null;
  sentimentScore: number | null;
  publishedAt: Date;
  /** Instrument names the article is tagged with (upper-case cash names, e.g. RELIANCE). */
  instruments: string[];
}

export interface Candidate {
  symbol: string;
  exchange: 'NSE';
  /** The strongest article's title. */
  headline: string;
  headlineUrl: string;
  newsIds: string[];
  /** Signed strength of the strongest article (+ bullish). */
  strength: number;
  articles: CandidateArticle[];
}

export function isMaterialAnnouncement(a: Pick<CandidateArticle, 'source' | 'title'>): boolean {
  return a.source === NSE_ANNOUNCEMENTS_SOURCE && MATERIAL_ANNOUNCEMENT.test(a.title) && !ROUTINE_ANNOUNCEMENT.test(a.title);
}

export function isStrong(a: CandidateArticle): boolean {
  return Math.abs(newsStrength(a)) >= STRONG_NEWS || isMaterialAnnouncement(a);
}

/**
 * @param fno     underlying names with a live NFO contract (instrument master)
 * @param held    underlyings already held (open positions) — never an idea
 * @param already article ids an earlier batch already turned into an idea
 */
export function shortlist(
  articles: readonly CandidateArticle[],
  fno: ReadonlySet<string>,
  held: ReadonlySet<string>,
  already: ReadonlySet<string> = new Set(),
  cap = SHORTLIST_CAP,
): Candidate[] {
  const bySymbol = new Map<string, CandidateArticle[]>();
  for (const a of articles) {
    if (already.has(a.id) || !isStrong(a)) continue;
    for (const raw of new Set(a.instruments.map((s) => s.trim().toUpperCase()).filter(Boolean))) {
      if (!fno.has(raw) || held.has(raw)) continue;
      bySymbol.set(raw, [...(bySymbol.get(raw) ?? []), a]);
    }
  }
  const out: Candidate[] = [];
  for (const [symbol, list] of bySymbol) {
    const sorted = [...list].sort((x, y) => Math.abs(newsStrength(y)) - Math.abs(newsStrength(x)) || y.publishedAt.getTime() - x.publishedAt.getTime());
    const best = sorted[0];
    out.push({
      symbol,
      exchange: 'NSE',
      headline: best.title,
      headlineUrl: best.url,
      newsIds: sorted.map((a) => a.id),
      strength: newsStrength(best),
      articles: sorted,
    });
  }
  return out
    .sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength) || a.symbol.localeCompare(b.symbol))
    .slice(0, cap);
}
