import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { SessionClock } from '../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { NEWS_IMPACT_CONFIG, parseNewsImpactConfig } from './news-impact.config';
import { NEWS_DIGEST_SOURCE, NEWS_IMPACT_IDEAS, NEWS_IMPACT_REVIEW } from './news-impact.ports';
import { NewsImpactRepository } from './news-impact.repository';
import { NewsClusterService } from './services/news-cluster.service';
import { IMPACT_LLM, NewsImpactLlmService } from './services/news-impact-llm.service';
import { NEWS_IMPACT_CLOCK, NewsImpactService } from './services/news-impact.service';
import { NewsImpactReadService } from './services/news-impact-read.service';
import { NewsReactionService } from './services/news-reaction.service';

/**
 * News impact (2026-10-24), cheapest layer first:
 *   1. clustering + NSE announcement type + relevance on every article (free, every 2 min, 3-day backfill);
 *   2. ONE batched cheap-model call per run over new relevant + material clusters (15 min in session,
 *      2 h otherwise, ≤ 30 per call, ≤ NEWS_IMPACT_DAILY_CALLS per day, shared non-reserved slot);
 *   3. HIGH impacts → 'news.impact.high' (sentinel news wake) + one ops alert; ranked impacts feed news
 *      ideas and the night report digest;
 *   4. reactions (+15 m / +60 m / close / next close) for the self-review NEWS_IMPACT kind.
 * `@Global` so the night report, news ideas and self-review inject the read ports @Optional.
 */
@Global()
@Module({
  imports: [PrismaModule, AiGatewayModule, TradeSentinelModule],
  providers: [
    { provide: NEWS_IMPACT_CONFIG, useFactory: () => parseNewsImpactConfig(process.env) },
    { provide: NEWS_IMPACT_CLOCK, useFactory: () => new SessionClock({ holidays: MARKET_HOLIDAYS }) },
    NewsImpactRepository,
    NewsImpactLlmService,
    { provide: IMPACT_LLM, useExisting: NewsImpactLlmService },
    NewsClusterService,
    NewsImpactService,
    NewsReactionService,
    NewsImpactReadService,
    { provide: NEWS_DIGEST_SOURCE, useExisting: NewsImpactReadService },
    { provide: NEWS_IMPACT_IDEAS, useExisting: NewsImpactReadService },
    { provide: NEWS_IMPACT_REVIEW, useExisting: NewsImpactReadService },
  ],
  exports: [NEWS_DIGEST_SOURCE, NEWS_IMPACT_IDEAS, NEWS_IMPACT_REVIEW],
})
export class NewsImpactModule {}
