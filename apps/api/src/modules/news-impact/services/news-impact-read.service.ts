import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MAGNITUDES, type Magnitude } from '../domain/impact';
import { isIndexSymbol, type ReactionRow } from '../domain/reaction';
import type { ImpactIdeaArticle, ImpactIdeaSource, NewsDigestItem, NewsDigestSource, NewsDigestView } from '../news-impact.ports';
import { NewsImpactRepository, type ImpactWithCluster, type StoredReaction } from '../news-impact.repository';

/** The latest filled reaction point vs p0, as a % move. */
export function reactionSoFar(r: Pick<StoredReaction, 'symbol' | 'p0' | 'p15' | 'p60' | 'pClose' | 'pNextClose'>): NewsDigestItem['reaction'][number] {
  const pts: Array<[NewsDigestItem['reaction'][number]['at'], number | null]> = [
    ['nextClose', r.pNextClose],
    ['close', r.pClose],
    ['p60', r.p60],
    ['p15', r.p15],
  ];
  if (r.p0 === null || !(r.p0 > 0)) return { symbol: r.symbol, movePct: null, at: null };
  for (const [at, v] of pts) if (v !== null) return { symbol: r.symbol, movePct: Math.round(((v - r.p0) / r.p0) * 10_000) / 100, at };
  return { symbol: r.symbol, movePct: null, at: null };
}

/** Digest order: magnitude first, then the stored rank. */
export function digestOrder(a: Pick<ImpactWithCluster, 'magnitude' | 'rank'>, b: Pick<ImpactWithCluster, 'magnitude' | 'rank'>): number {
  const m = (x: string) => MAGNITUDES.indexOf(x as Magnitude);
  return m(b.magnitude) - m(a.magnitude) || b.rank - a.rank;
}

/** Reads for other modules: the night report digest, the news-ideas shortlist feed, the self-review rows. */
@Injectable()
export class NewsImpactReadService implements NewsDigestSource, ImpactIdeaSource {
  constructor(
    private readonly repo: NewsImpactRepository,
    private readonly prisma: PrismaService,
  ) {}

  async digest(from: Date, to: Date, limit = 10): Promise<NewsDigestView> {
    const impacts = (await this.repo.impactsBetween(from, to, 300)).filter((i) => i.direction !== 'NEUTRAL' || i.magnitude !== 'LOW');
    const top = impacts.sort(digestOrder).slice(0, limit);
    const reactions = await this.repo.reactionsForClusters(top.map((i) => i.clusterId));
    const byCluster = new Map<string, StoredReaction[]>();
    for (const r of reactions) byCluster.set(r.clusterId, [...(byCluster.get(r.clusterId) ?? []), r]);
    return {
      since: from.toISOString(),
      note: 'Top news of the window as read by the cheap model (direction, magnitude, horizon), with the market reaction recorded so far. Context only — never a trade trigger.',
      items: top.map((i) => ({
        clusterId: i.clusterId,
        headline: i.cluster.headline,
        direction: i.direction,
        magnitude: i.magnitude,
        horizon: i.horizon,
        pricedIn: i.pricedIn,
        confidence: i.confidence,
        oneLine: i.oneLine,
        affected: { symbols: i.symbols, sectors: i.sectors, index: i.indexName },
        sources: i.cluster.sources,
        sourceCount: i.cluster.sourceCount,
        materialType: i.cluster.materialType,
        firstSeen: i.cluster.firstSeen.toISOString(),
        analysedAt: i.analysedAt.toISOString(),
        reaction: (byCluster.get(i.clusterId) ?? []).map(reactionSoFar),
      })),
    };
  }

  /**
   * Top impacts of [from, to] (non-NEUTRAL, by rank) as one article per affected STOCK, carrying the
   * impact's signed strength — the news-ideas shortlist then applies its own F&O / held / cap rules.
   */
  async rankedArticles(from: Date, to: Date, limit: number): Promise<ImpactIdeaArticle[]> {
    const impacts = (await this.repo.impactsBetween(from, to, 200)).filter((i) => i.direction !== 'NEUTRAL' && !i.pricedIn && i.magnitude !== 'LOW');
    const top = impacts.sort((a, b) => b.rank - a.rank).slice(0, limit);
    if (top.length === 0) return [];
    const firstIds = top.map((i) => i.cluster.articleIds[0]).filter(Boolean);
    const arts = await this.prisma.newsArticle.findMany({ where: { id: { in: firstIds } }, select: { id: true, url: true, source: true, publishedAt: true } });
    const byId = new Map(arts.map((a) => [a.id, a]));
    const out: ImpactIdeaArticle[] = [];
    for (const i of top) {
      const a = byId.get(i.cluster.articleIds[0]);
      if (!a) continue;
      const sign = i.direction === 'BULL' ? 1 : -1;
      const symbols = (i.symbols.length ? i.symbols : i.cluster.instruments).filter((x) => !isIndexSymbol(x));
      if (symbols.length === 0) continue;
      out.push({
        // A synthetic id per cluster: the shortlist's "already an idea" set is keyed by article ids.
        id: a.id,
        title: `${i.cluster.headline} — ${i.oneLine}`.slice(0, 300),
        url: a.url,
        source: a.source,
        publishedAt: a.publishedAt,
        instruments: symbols,
        // The shortlist ranks on |strength| and needs ≥ 0.5 ("strong"): a model-read MED / HIGH impact
        // clears it (0.75 / 1.0) and outranks keyword-only articles; LOW never reaches here.
        sentimentScore: sign * (i.magnitude === 'HIGH' ? 1 : 0.75),
        sentiment: sign > 0 ? 'bullish' : 'bearish',
      });
    }
    return out;
  }

  /** Self-review NEWS_IMPACT rows judged on `session`. */
  async reactionRows(session: string): Promise<ReactionRow[]> {
    const rows = await this.repo.reactionsForSession(session);
    return rows.map((r) => ({
      id: r.id,
      clusterId: r.clusterId,
      symbol: r.symbol,
      direction: r.direction,
      magnitude: r.magnitude,
      horizon: r.horizon,
      judgeSession: r.judgeSession,
      atr: r.atr,
      p0: r.p0,
      p15: r.p15,
      p60: r.p60,
      pClose: r.pClose,
      pNextClose: r.pNextClose,
      materialType: r.materialType,
      firstSource: r.sources[0] ?? 'unknown',
      sources: r.sources,
      headline: r.headline,
      oneLine: r.oneLine,
    }));
  }
}
