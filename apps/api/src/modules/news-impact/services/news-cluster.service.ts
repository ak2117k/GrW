import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { baseSymbol } from '../../news-events/keys';
import { classifyArticle } from '../domain/announcement-classifier';
import { assignClusters, CLUSTER_WINDOW_MS, type ClusterArticle, type ClusterState } from '../domain/clustering';
import { relevanceOf, type RelevanceContext } from '../domain/relevance';
import { NEWS_IMPACT_CONFIG, type NewsImpactConfig } from '../news-impact.config';
import { NewsImpactRepository, type ArticleRow } from '../news-impact.repository';

/** Articles clustered per chunk, chunks per run (a run after a restart catches up on the 3-day backfill). */
export const CLUSTER_CHUNK = 400;
export const CLUSTER_CHUNKS_PER_RUN = 10;
/** Layer 1 looks back this far for unclustered articles — the backfill window. */
export const BACKFILL_MS = 3 * 86_400_000;
const CONTEXT_TTL_MS = 10 * 60_000;

export function toClusterArticle(a: ArticleRow): ClusterArticle {
  const instruments = [...new Set([...(a.instruments ?? []), ...(a.relatedSymbols ?? []).map(baseSymbol)].map((s) => s.trim().toUpperCase()).filter(Boolean))];
  return {
    id: a.id,
    title: a.title,
    summary: a.summary,
    source: a.source,
    publishedAt: a.publishedAt,
    instruments,
    sectors: a.sectors ?? [],
    indices: a.indices ?? [],
    cls: classifyArticle(a),
  };
}

/**
 * Layer 1 (free, every article): cluster → classify → relevance, every 2 minutes over articles not
 * yet clustered (fetched in the last 3 days — so the first run after deploy IS the 3-day backfill).
 * Runs regardless of NSE session; never calls a model.
 */
@Injectable()
export class NewsClusterService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NewsClusterService.name);
  private running = false;
  private ctx: { at: number; value: RelevanceContext } | null = null;

  constructor(
    private readonly repo: NewsImpactRepository,
    @Inject(NEWS_IMPACT_CONFIG) private readonly cfg: NewsImpactConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.cfg.enabled && bootJobsEnabled()) setTimeout(() => void this.tick(), 45_000).unref?.();
  }

  @Cron('20 */2 * * * *', { name: 'news-impact-cluster', timeZone: 'Asia/Kolkata' })
  async tick(): Promise<number> {
    if (!this.cfg.enabled || !bootJobsEnabled() || this.running) return 0;
    this.running = true;
    try {
      let total = 0;
      for (let i = 0; i < CLUSTER_CHUNKS_PER_RUN; i++) {
        const n = await this.runOnce(new Date());
        total += n;
        if (n < CLUSTER_CHUNK) break;
      }
      if (total > 0) this.logger.log(`[news-impact] clustered ${total} article(s)`);
      return total;
    } catch (e) {
      this.logger.warn(`[news-impact] clustering failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** One chunk: returns how many articles were clustered. */
  async runOnce(now: Date): Promise<number> {
    const rows = await this.repo.unclusteredArticles(new Date(now.getTime() - BACKFILL_MS), CLUSTER_CHUNK);
    if (rows.length === 0) return 0;
    const articles = rows.map(toClusterArticle);
    const oldest = Math.min(...articles.map((a) => a.publishedAt.getTime()));
    const open = await this.repo.openClusters(new Date(oldest - CLUSTER_WINDOW_MS));
    const assigned = assignClusters(articles, open);
    const ctx = await this.context(now);
    const texts = new Map<ClusterState, string[]>();
    for (const a of articles) {
      const c = assigned.get(a.id)!;
      texts.set(c, [...(texts.get(c) ?? []), `${a.title} ${a.summary ?? ''}`]);
    }
    let done = 0;
    for (const [c, extra] of texts) {
      const rel = c.boilerplate
        ? { score: 0, reasons: ['boilerplate'] }
        : relevanceOf({ instruments: c.instruments, indices: c.indices, text: [c.headline, ...extra].join(' '), sourceCount: c.sources.length }, ctx);
      try {
        c.id = await this.repo.saveCluster(c, rel);
        done += extra.length;
      } catch (e) {
        this.logger.warn(`[news-impact] saving cluster "${c.headline.slice(0, 60)}" failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return done;
  }

  private async context(now: Date): Promise<RelevanceContext> {
    if (this.ctx && now.getTime() - this.ctx.at < CONTEXT_TTL_MS) return this.ctx.value;
    const [fno, held] = await Promise.all([
      this.repo.fnoNames(now).catch(() => new Set<string>()),
      this.repo.heldUnderlyings().catch(() => new Set<string>()),
    ]);
    this.ctx = { at: now.getTime(), value: { fno, held } };
    return this.ctx.value;
  }
}
