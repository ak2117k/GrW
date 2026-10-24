import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { underlyingName } from '../night-report/domain/night-report.logic';
import { baseSymbol } from '../news-events/keys';
import type { ClusterState } from './domain/clustering';
import type { ClusterForImpact, ImpactItem } from './domain/impact';
import type { Bar, ReactionPoints } from './domain/reaction';
import { NSE_ANNOUNCEMENTS } from './domain/announcement-classifier';

export const NEWS_IMPACT_JOB = 'news.impact';

export interface ArticleRow {
  id: string;
  title: string;
  summary: string | null;
  source: string;
  publishedAt: Date;
  instruments: string[];
  relatedSymbols: string[];
  sectors: string[];
  indices: string[];
}

export interface ImpactWithCluster {
  id: string;
  clusterId: string;
  analysedAt: Date;
  direction: string;
  magnitude: string;
  horizon: string;
  symbols: string[];
  sectors: string[];
  indexName: string | null;
  pricedIn: boolean;
  confidence: number;
  oneLine: string;
  rank: number;
  alertedAt: Date | null;
  cluster: {
    headline: string;
    sources: string[];
    sourceCount: number;
    firstSeen: Date;
    lastSeen: Date;
    materialType: string;
    relevance: number;
    articleIds: string[];
    instruments: string[];
  };
}

export interface StoredReaction extends ReactionPoints {
  id: string;
  impactId: string;
  clusterId: string;
  symbol: string;
  kind: string;
  direction: string;
  magnitude: string;
  horizon: string;
  anchorAt: Date;
  anchorIsOpen: boolean;
  judgeSession: string | null;
  atr: number | null;
  createdAt: Date;
}

/** All DB access of the news-impact module. */
@Injectable()
export class NewsImpactRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Layer 1 ───────────────────────────────────────────────────────────────

  unclusteredArticles(since: Date, take: number): Promise<ArticleRow[]> {
    return this.prisma.newsArticle.findMany({
      where: { clusterId: null, fetchedAt: { gte: since } },
      select: { id: true, title: true, summary: true, source: true, publishedAt: true, instruments: true, relatedSymbols: true, sectors: true, indices: true },
      orderBy: { publishedAt: 'asc' },
      take,
    });
  }

  async openClusters(since: Date): Promise<ClusterState[]> {
    const rows = await this.prisma.newsCluster.findMany({ where: { lastSeen: { gte: since }, boilerplate: false }, take: 5000 });
    return rows.map((r) => ({
      id: r.id,
      headline: r.headline,
      headlineSource: r.sources.some((s) => s !== NSE_ANNOUNCEMENTS) ? 'press' : NSE_ANNOUNCEMENTS,
      instruments: r.instruments,
      sectors: r.sectors,
      indices: r.indices,
      sources: r.sources,
      articleIds: r.articleIds,
      titleTokens: r.titleTokens,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      types: [r.materialType as ClusterState['materialType']],
      materialType: r.materialType as ClusterState['materialType'],
      material: r.material,
      boilerplate: r.boilerplate,
    }));
  }

  /** Create or update a cluster and point its articles at it. Returns the id. */
  async saveCluster(c: ClusterState, relevance: { score: number; reasons: string[] }): Promise<string> {
    const data = {
      headline: c.headline.slice(0, 500),
      instruments: c.instruments,
      sectors: c.sectors,
      indices: c.indices,
      sources: c.sources,
      sourceCount: c.sources.length,
      articleIds: c.articleIds,
      titleTokens: c.titleTokens,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
      materialType: c.materialType,
      material: c.material,
      boilerplate: c.boilerplate,
      relevance: relevance.score,
      reasons: relevance.reasons,
    };
    const id = c.id ? (await this.prisma.newsCluster.update({ where: { id: c.id }, data, select: { id: true } })).id : (await this.prisma.newsCluster.create({ data, select: { id: true } })).id;
    await this.prisma.newsArticle.updateMany({ where: { id: { in: c.articleIds }, clusterId: null }, data: { clusterId: id } });
    return id;
  }

  async fnoNames(now: Date): Promise<Set<string>> {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const rows = await this.prisma.instrument.findMany({ where: { exchange: 'NFO', expiry: { gte: day } }, select: { name: true }, distinct: ['name'] });
    return new Set(rows.map((r) => r.name.trim().toUpperCase()));
  }

  /** Underlyings of every OPEN tracker (the owner's and any other open position). */
  async heldUnderlyings(): Promise<Set<string>> {
    const rows = await this.prisma.tradeTracker.findMany({ where: { status: 'OPEN' }, select: { symbol: true, exchange: true }, distinct: ['symbol', 'exchange'] });
    return new Set(rows.map((t) => (underlyingName(t.symbol, t.exchange) ?? baseSymbol(t.symbol)).toUpperCase()));
  }

  // ─── Layer 2 ───────────────────────────────────────────────────────────────

  async impactCandidates(since: Date, minRelevance: number): Promise<ClusterForImpact[]> {
    const rows = await this.prisma.newsCluster.findMany({
      where: { lastSeen: { gte: since }, boilerplate: false, relevance: { gte: minRelevance } },
      orderBy: { relevance: 'desc' },
      take: 600,
    });
    if (rows.length === 0) return [];
    const impacts = await this.prisma.newsImpact.findMany({ where: { clusterId: { in: rows.map((r) => r.id) } }, select: { clusterId: true, sourceCountAt: true } });
    const at = new Map(impacts.map((i) => [i.clusterId, i.sourceCountAt]));
    return rows.map((r) => ({
      id: r.id,
      headline: r.headline,
      instruments: r.instruments,
      sectors: r.sectors,
      indices: r.indices,
      sources: r.sources,
      sourceCount: r.sourceCount,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      materialType: r.materialType,
      material: r.material,
      boilerplate: r.boilerplate,
      relevance: r.relevance,
      reasons: r.reasons,
      impactAttempts: r.impactAttempts,
      analysedSourceCount: at.get(r.id) ?? null,
    }));
  }

  /** ≤ 3 titles and the first non-empty summary per cluster (for the prompt). */
  async clusterTexts(clusters: ReadonlyArray<{ id: string; articleIds?: string[] }>): Promise<Map<string, { titles: string[]; summary: string | null }>> {
    const rows = await this.prisma.newsArticle.findMany({
      where: { clusterId: { in: clusters.map((c) => c.id) } },
      select: { clusterId: true, title: true, summary: true, publishedAt: true },
      orderBy: { publishedAt: 'asc' },
      take: clusters.length * 6,
    });
    const out = new Map<string, { titles: string[]; summary: string | null }>();
    for (const r of rows) {
      if (!r.clusterId) continue;
      const e = out.get(r.clusterId) ?? { titles: [], summary: null };
      if (e.titles.length < 3) e.titles.push(r.title);
      if (!e.summary && r.summary && r.summary.trim()) e.summary = r.summary;
      out.set(r.clusterId, e);
    }
    return out;
  }

  async bumpAttempts(ids: readonly string[]): Promise<void> {
    if (ids.length) await this.prisma.newsCluster.updateMany({ where: { id: { in: [...ids] } }, data: { impactAttempts: { increment: 1 } } });
  }

  async upsertImpact(i: ImpactItem, model: string, sourceCount: number, rank: number, at: Date): Promise<{ id: string; alertedAt: Date | null }> {
    const data = {
      analysedAt: at,
      model,
      sourceCountAt: sourceCount,
      direction: i.direction,
      magnitude: i.magnitude,
      horizon: i.horizon,
      symbols: i.affected.symbols,
      sectors: i.affected.sectors,
      indexName: i.affected.index,
      pricedIn: i.pricedIn,
      confidence: i.confidence,
      oneLine: i.oneLine,
      rank,
    };
    return this.prisma.newsImpact.upsert({
      where: { clusterId: i.clusterId },
      create: { clusterId: i.clusterId, ...data },
      update: { ...data, analyses: { increment: 1 } },
      select: { id: true, alertedAt: true },
    });
  }

  async markAlerted(impactId: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.newsImpact.updateMany({ where: { id: impactId, alertedAt: null }, data: { alertedAt: at } });
    return count === 1;
  }

  async setClusterSentiment(clusterId: string, sentiment: string, score: number): Promise<number> {
    const { count } = await this.prisma.newsArticle.updateMany({ where: { clusterId }, data: { sentiment, sentimentScore: score } });
    return count;
  }

  aiCallsSince(since: Date): Promise<number> {
    return this.prisma.aiCall.count({ where: { job: NEWS_IMPACT_JOB, createdAt: { gte: since } } });
  }

  async lastAiCallAt(): Promise<Date | null> {
    const r = await this.prisma.aiCall.findFirst({ where: { job: NEWS_IMPACT_JOB }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return r?.createdAt ?? null;
  }

  // ─── Layer 3 reads ─────────────────────────────────────────────────────────

  async impactsBetween(from: Date, to: Date, take = 200): Promise<ImpactWithCluster[]> {
    const impacts = await this.prisma.newsImpact.findMany({ where: { analysedAt: { gte: from, lte: to } }, orderBy: { rank: 'desc' }, take });
    if (impacts.length === 0) return [];
    const clusters = await this.prisma.newsCluster.findMany({
      where: { id: { in: impacts.map((i) => i.clusterId) } },
      select: { id: true, headline: true, sources: true, sourceCount: true, firstSeen: true, lastSeen: true, materialType: true, relevance: true, articleIds: true, instruments: true },
    });
    const byId = new Map(clusters.map((c) => [c.id, c]));
    return impacts.flatMap((i) => {
      const c = byId.get(i.clusterId);
      return c ? [{ ...i, cluster: c }] : [];
    });
  }

  // ─── Layer 4 ───────────────────────────────────────────────────────────────

  async createReaction(r: Omit<StoredReaction, 'id' | 'createdAt' | 'p0' | 'p15' | 'p60' | 'pClose' | 'pNextClose'>): Promise<void> {
    await this.prisma.newsReaction.upsert({
      where: { clusterId_symbol: { clusterId: r.clusterId, symbol: r.symbol } },
      create: { ...r },
      update: { impactId: r.impactId, direction: r.direction, magnitude: r.magnitude, horizon: r.horizon },
    });
  }

  incompleteReactions(since: Date, take = 300): Promise<StoredReaction[]> {
    return this.prisma.newsReaction.findMany({ where: { complete: false, anchorAt: { gte: since } }, orderBy: { anchorAt: 'asc' }, take });
  }

  async updateReaction(id: string, p: ReactionPoints & { atr?: number | null; complete: boolean }, at: Date): Promise<void> {
    await this.prisma.newsReaction.update({ where: { id }, data: { ...p, filledAt: at } });
  }

  /** Reactions judged on `session`, with their impact one-liner and cluster facts (self-review). */
  async reactionsForSession(session: string): Promise<
    Array<StoredReaction & { oneLine: string; headline: string; materialType: string; sources: string[] }>
  > {
    const rows = await this.prisma.newsReaction.findMany({ where: { judgeSession: session }, take: 2000 });
    if (rows.length === 0) return [];
    const [impacts, clusters] = await Promise.all([
      this.prisma.newsImpact.findMany({ where: { id: { in: rows.map((r) => r.impactId) } }, select: { id: true, oneLine: true } }),
      this.prisma.newsCluster.findMany({ where: { id: { in: rows.map((r) => r.clusterId) } }, select: { id: true, headline: true, materialType: true, sources: true } }),
    ]);
    const im = new Map(impacts.map((i) => [i.id, i.oneLine]));
    const cl = new Map(clusters.map((c) => [c.id, c]));
    return rows.map((r) => ({
      ...r,
      oneLine: im.get(r.impactId) ?? '',
      headline: cl.get(r.clusterId)?.headline ?? '',
      materialType: cl.get(r.clusterId)?.materialType ?? 'unknown',
      sources: cl.get(r.clusterId)?.sources ?? [],
    }));
  }

  /** Reactions per cluster (digest "reaction so far"). */
  reactionsForClusters(clusterIds: readonly string[]): Promise<StoredReaction[]> {
    if (clusterIds.length === 0) return Promise.resolve([]);
    return this.prisma.newsReaction.findMany({ where: { clusterId: { in: [...clusterIds] } } });
  }

  /**
   * 1m bars for a symbol in [from, to]: NIFTY / BANKNIFTY and the MBM equity series from
   * mbm_bars_1m; other stocks from `candles` (timeframe 1m, NSE cash). [] when there are none.
   */
  async minuteBars(symbol: string, from: Date, to: Date): Promise<Bar[]> {
    const series = symbol === 'NIFTY' || symbol === 'BANKNIFTY' ? symbol : `EQ_${symbol}`;
    const mbm = await this.prisma.mbmBar1m.findMany({ where: { series, ts: { gte: from, lte: to } }, select: { ts: true, open: true, close: true }, orderBy: { ts: 'asc' } });
    if (mbm.length > 0 || series === symbol) return mbm.map((b) => ({ t: b.ts.getTime(), open: b.open, close: b.close }));
    const inst = await this.cashInstrumentId(symbol);
    if (!inst) return [];
    const rows = await this.prisma.candle.findMany({
      where: { instrumentId: inst, timeframe: '1m', timestamp: { gte: from, lte: to } },
      select: { timestamp: true, open: true, close: true },
      orderBy: { timestamp: 'asc' },
    });
    return rows.map((b) => ({ t: b.timestamp.getTime(), open: b.open, close: b.close }));
  }

  /** Daily OHLC (oldest first) for ATR: `candles` 1d for stocks, else mbm 1m aggregated per IST day. */
  async dailyBars(symbol: string, before: Date, days = 20): Promise<Array<{ high: number; low: number; close: number }>> {
    const from = new Date(before.getTime() - days * 1.6 * 86_400_000);
    if (symbol !== 'NIFTY' && symbol !== 'BANKNIFTY') {
      const inst = await this.cashInstrumentId(symbol);
      if (inst) {
        const rows = await this.prisma.candle.findMany({
          where: { instrumentId: inst, timeframe: '1d', timestamp: { gte: from, lt: before } },
          select: { high: true, low: true, close: true },
          orderBy: { timestamp: 'asc' },
        });
        if (rows.length >= 5) return rows;
      }
    }
    const series = symbol === 'NIFTY' || symbol === 'BANKNIFTY' ? symbol : `EQ_${symbol}`;
    const rows = await this.prisma.$queryRaw<Array<{ high: number; low: number; close: number }>>`
      SELECT max(high) AS high, min(low) AS low, (array_agg(close ORDER BY ts DESC))[1] AS close
      FROM mbm_bars_1m
      WHERE series = ${series} AND ts >= ${from} AND ts < ${before}
      GROUP BY (ts AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY (ts AT TIME ZONE 'Asia/Kolkata')::date ASC`;
    return rows.map((r) => ({ high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
  }

  private readonly cashIds = new Map<string, string | null>();

  private async cashInstrumentId(symbol: string): Promise<string | null> {
    if (this.cashIds.has(symbol)) return this.cashIds.get(symbol) ?? null;
    const row = await this.prisma.instrument.findFirst({
      where: { exchange: 'NSE', OR: [{ symbol: `${symbol}-EQ` }, { symbol }] },
      select: { id: true },
    });
    this.cashIds.set(symbol, row?.id ?? null);
    return row?.id ?? null;
  }
}
