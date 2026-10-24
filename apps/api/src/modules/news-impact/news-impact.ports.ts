/**
 * What other modules read from news-impact. Tokens are provided by the @Global NewsImpactModule;
 * every consumer injects them @Optional, so a container without the module behaves as before.
 */

/** In-process event (EventEmitter2) for a HIGH impact on a held symbol / NIFTY / BANKNIFTY. */
export const NEWS_IMPACT_HIGH_EVENT = 'news.impact.high';

export interface NewsImpactHighEvent {
  clusterId: string;
  impactId: string;
  headline: string;
  direction: string;
  magnitude: string;
  horizon: string;
  oneLine: string;
  /** Upper-case names the impact concerns (held symbols and/or NIFTY / BANKNIFTY). */
  targets: string[];
  analysedAt: string;
}

/** Ranked impacted clusters for the news-ideas batch (overnight-scorecard). */
export const NEWS_IMPACT_IDEAS = Symbol('NEWS_IMPACT_IDEAS');

export interface ImpactIdeaArticle {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: Date;
  instruments: string[];
  /** Signed strength from the impact (+ bullish), replaces the keyword sentiment for ranking. */
  sentimentScore: number;
  sentiment: string;
}

export interface ImpactIdeaSource {
  /** Top-ranked impacts analysed in [from, to], as one representative article per affected symbol. */
  rankedArticles(from: Date, to: Date, limit: number): Promise<ImpactIdeaArticle[]>;
}

/** Night report "News digest". */
export const NEWS_DIGEST_SOURCE = Symbol('NEWS_DIGEST_SOURCE');

export interface NewsDigestItem {
  clusterId: string;
  headline: string;
  direction: string;
  magnitude: string;
  horizon: string;
  pricedIn: boolean;
  confidence: number;
  oneLine: string;
  affected: { symbols: string[]; sectors: string[]; index: string | null };
  sources: string[];
  sourceCount: number;
  materialType: string;
  firstSeen: string;
  analysedAt: string;
  /** Per affected symbol: % move since publish (latest filled point), null when no bars yet. */
  reaction: Array<{ symbol: string; movePct: number | null; at: 'p15' | 'p60' | 'close' | 'nextClose' | null }>;
}

export interface NewsDigestView {
  since: string;
  note: string;
  items: NewsDigestItem[];
}

export interface NewsDigestSource {
  digest(from: Date, to: Date, limit?: number): Promise<NewsDigestView>;
}

/** Self-review NEWS_IMPACT source: the reactions judged on a session. */
export const NEWS_IMPACT_REVIEW = Symbol('NEWS_IMPACT_REVIEW');

export interface NewsImpactReviewSource {
  reactionRows(session: string): Promise<import('./domain/reaction').ReactionRow[]>;
}
