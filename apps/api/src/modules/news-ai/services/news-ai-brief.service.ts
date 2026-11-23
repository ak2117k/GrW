import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { briefWindowOpen, buildBriefMessage, selectBriefArticles, type OwnerHolding } from '../domain/news-ai.inputs';
import { validateBriefReply } from '../domain/news-ai.validate';
import { NEWS_AI_CONFIG, type NewsAiConfig } from '../news-ai.config';
import { NEWS_AI_STORE, type NewsAiStore, type StoredBrief } from '../news-ai.repository';
import { NEWS_AI_LLM, type NewsAiLlm } from './news-ai-llm.service';

export interface BriefRunSummary {
  ran: boolean;
  reason?: string;
  articles?: number;
  briefId?: string;
}

/** On-demand refreshes: at most one start per this many ms (the controller also throttles per IP). */
export const BRIEF_REFRESH_MIN_GAP_MS = 60_000;
/** A scheduled run with no new AI reads since the last brief is skipped unless the brief is older than this. */
const STALE_BRIEF_MS = 60 * 60_000;
const HOUR = 3_600_000;

export class BriefRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`brief refresh rate-limited; retry in ${Math.ceil(retryAfterMs / 1000)} s`);
  }
}

/**
 * The page brief (job 'news.brief', Opus, effort high): every 15 min on weekdays 08:00-23:30 IST and
 * on demand. Input = AI-read, unfiltered articles of the last 6 h (24 h when the last 6 h is thin),
 * most important first, capped, plus the owner's open trade_trackers. The validated brief (every
 * point citing article ids actually sent) is stored in news_briefs; a bad reply stores nothing.
 */
@Injectable()
export class NewsAiBriefService {
  private readonly logger = new Logger(NewsAiBriefService.name);
  private running: Promise<BriefRunSummary> | null = null;
  private lastManualAt = 0;

  constructor(
    @Inject(NEWS_AI_STORE) private readonly store: NewsAiStore,
    @Inject(NEWS_AI_LLM) private readonly llm: NewsAiLlm,
    @Inject(NEWS_AI_CONFIG) private readonly cfg: NewsAiConfig,
  ) {}

  get building(): boolean {
    return this.running !== null;
  }

  @Cron('0 */15 * * * *', { name: 'news-ai-brief', timeZone: 'Asia/Kolkata' })
  async onTick(): Promise<BriefRunSummary> {
    if (!bootJobsEnabled()) return { ran: false, reason: 'boot jobs off' };
    const now = new Date();
    if (!briefWindowOpen(now)) return { ran: false, reason: 'outside weekday 08:00-23:30 IST' };
    return this.run(now, 'cron');
  }

  /**
   * On-demand build (POST /api/news-ai/brief/refresh). Starts in the background and returns at once;
   * the page polls GET /brief (which reports `building`). Throws BriefRateLimitedError within 60 s of
   * the previous on-demand start.
   */
  refresh(now = new Date()): { status: 'started' | 'running' | 'off' } {
    if (!this.cfg.enabled) return { status: 'off' };
    if (this.running) return { status: 'running' };
    const gap = now.getTime() - this.lastManualAt;
    if (gap < BRIEF_REFRESH_MIN_GAP_MS) throw new BriefRateLimitedError(BRIEF_REFRESH_MIN_GAP_MS - gap);
    this.lastManualAt = now.getTime();
    void this.run(now, 'manual');
    return { status: 'started' };
  }

  async run(now: Date, trigger: 'cron' | 'manual'): Promise<BriefRunSummary> {
    if (!this.cfg.enabled) return { ran: false, reason: 'NEWS_AI off' };
    if (this.running) return { ran: false, reason: 'previous run still going' };
    const p = this.build(now, trigger).finally(() => {
      this.running = null;
    });
    this.running = p;
    return p;
  }

  private async build(now: Date, trigger: 'cron' | 'manual'): Promise<BriefRunSummary> {
    try {
      if (!(await this.store.tablesReady())) return { ran: false, reason: 'news-ai tables missing' };
      if (trigger === 'cron') {
        const [last, lastRead] = await Promise.all([this.store.latestBrief(), this.store.latestReadAt()]);
        const fresh = last && now.getTime() - last.createdAt.getTime() < STALE_BRIEF_MS;
        if (fresh && (!lastRead || lastRead <= last.createdAt)) return { ran: false, reason: 'no new AI reads since the last brief' };
      }
      const holdings: OwnerHolding[] = this.cfg.ownerUserId ? await this.store.ownerHoldings(this.cfg.ownerUserId).catch(() => []) : [];
      const reads = await this.store.readsSince(new Date(now.getTime() - 24 * HOUR));
      const sel = selectBriefArticles(reads, holdings, now, { max: this.cfg.briefMaxArticles, minRecent: this.cfg.briefMinRecent });
      if (sel.articles.length === 0) return { ran: false, reason: 'no AI-read articles in the last 24 h' };

      const reply = await this.llm.writeBrief(buildBriefMessage(sel, holdings, now));
      const v = validateBriefReply(reply, new Set(sel.articles.map((a) => a.id)));
      if (!v.ok) {
        this.logger.warn(`[news-ai] brief rejected: ${v.error}`);
        return { ran: true, reason: `invalid reply: ${v.error}`, articles: sel.articles.length };
      }
      const saved: StoredBrief = await this.store.saveBrief({
        model: this.cfg.briefModel,
        windowFrom: sel.windowFrom,
        windowTo: sel.windowTo,
        brief: { ...v.value, meta: { trigger, articleCount: sel.articles.length, holdingCount: holdings.length } },
      });
      return { ran: true, articles: sel.articles.length, briefId: saved.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`[news-ai] brief run failed: ${msg}`);
      return { ran: true, reason: msg };
    }
  }
}
