import { Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Inject, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type AuthenticatedUser } from '../../../common/decorators';
import { sentimentOverview } from '../domain/sentiment-overview';
import type { NewsAiBriefResponse, NewsAiOverviewResponse, NewsAiReadsResponse, NewsAiRefreshResponse } from '../news-ai.contract';
import { NEWS_AI_CONFIG, type NewsAiConfig } from '../news-ai.config';
import { NEWS_AI_STORE, type NewsAiStore, type StoredRead } from '../news-ai.repository';
import { BriefRateLimitedError, NewsAiBriefService } from '../services/news-ai-brief.service';

const MAX_IDS = 200;
const HOUR = 3_600_000;

/** Who may start an on-demand brief (an Opus call): the owner (HUB_OWNER_USER_ID) or an ADMIN. */
export function briefRefreshAllowed(user: Pick<AuthenticatedUser, 'userId' | 'role'> | undefined, ownerUserId: string | null): boolean {
  if (!user?.userId) return false;
  return (!!ownerUserId && user.userId === ownerUserId) || user.role === 'ADMIN';
}

/** Collect the article ids every brief point cites (for the page's citation links). */
export function citedIds(brief: Record<string, unknown> | null | undefined): string[] {
  if (!brief) return [];
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'articleIds' && Array.isArray(x)) x.forEach((id) => typeof id === 'string' && out.add(id));
        else if (k === 'articleId' && typeof x === 'string') out.add(x);
        else walk(x);
      }
    }
  };
  walk(brief);
  return [...out];
}

/**
 * /api/news-ai — Claude's reading of the news page. Same auth as /api/news: the global JwtAuthGuard
 * (no @Public here), any signed-in user may read; only the owner / an ADMIN may start a brief build
 * (GET /brief says so in canRefresh). Response shapes: ../news-ai.contract.ts.
 */
@ApiTags('News AI')
@Controller('api/news-ai')
export class NewsAiController {
  constructor(
    @Inject(NEWS_AI_STORE) private readonly store: NewsAiStore,
    private readonly briefs: NewsAiBriefService,
    @Inject(NEWS_AI_CONFIG) private readonly cfg: NewsAiConfig,
  ) {}

  @Get('brief')
  @ApiOperation({ summary: 'Latest AI "what matters now" brief, with the cited articles' })
  async brief(@CurrentUser() user?: AuthenticatedUser): Promise<NewsAiBriefResponse> {
    const canRefresh = briefRefreshAllowed(user, this.cfg.ownerUserId);
    const ready = await this.store.tablesReady();
    if (!ready) return { enabled: this.cfg.enabled, ready, building: false, canRefresh, brief: null, articles: [] };
    const stored = await this.store.latestBrief();
    // The brief is built from the OWNER's open holdings / positions. Any other signed-in user gets the
    // brief without that section (security review 2026-11-23: tenant data exposure).
    const brief = stored && !canRefresh ? { ...stored, brief: { ...stored.brief, holdings: [] } } : stored;
    const articles = brief ? await this.store.articleRefs(citedIds(brief.brief as unknown as Record<string, unknown>)) : [];
    return { enabled: this.cfg.enabled, ready, building: this.briefs.building, canRefresh, brief, articles };
  }

  @Post('brief/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  @ApiOperation({ summary: 'Build a fresh brief now (owner / admin; 1 per minute)' })
  async refresh(@CurrentUser() user?: AuthenticatedUser): Promise<NewsAiRefreshResponse> {
    if (!briefRefreshAllowed(user, this.cfg.ownerUserId)) throw new ForbiddenException('owner or admin only');
    if (!this.cfg.enabled) return { status: 'off' };
    if (!(await this.store.tablesReady())) return { status: 'unavailable' };
    try {
      return this.briefs.refresh();
    } catch (e) {
      if (e instanceof BriefRateLimitedError) throw new HttpException(e.message, HttpStatus.TOO_MANY_REQUESTS);
      throw e;
    }
  }

  @Get('reads')
  @ApiOperation({ summary: 'AI reads for article ids (?ids=a,b,c; max 200)' })
  async reads(@Query('ids') ids?: string | string[]): Promise<NewsAiReadsResponse> {
    const list = [...new Set((Array.isArray(ids) ? ids.join(',') : (ids ?? '')).split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
    const reads: Record<string, StoredRead> = {};
    if (list.length === 0 || !(await this.store.tablesReady())) return { reads };
    for (const r of await this.store.readsFor(list)) reads[r.articleId] = r;
    return { reads };
  }

  @Get('sentiment-overview')
  @ApiOperation({ summary: 'Aggregate of AI reads: counts + weighted score overall, per index, sector, commodity' })
  async overview(@Query('hours') hours?: string): Promise<NewsAiOverviewResponse> {
    const h = Math.min(168, Math.max(1, Math.floor(Number(hours) || 24)));
    const now = new Date();
    const ready = await this.store.tablesReady();
    const reads = ready ? await this.store.readsSince(new Date(now.getTime() - h * HOUR)) : [];
    return { enabled: this.cfg.enabled, ready, ...sentimentOverview(reads, h, now) };
  }
}
