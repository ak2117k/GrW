import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { NewsAiController } from './controllers/news-ai.controller';
import { NEWS_AI_CONFIG, parseNewsAiConfig } from './news-ai.config';
import { NEWS_AI_STORE, NewsAiRepository } from './news-ai.repository';
import { NewsAiBriefService } from './services/news-ai-brief.service';
import { NEWS_AI_LLM, NewsAiLlmService } from './services/news-ai-llm.service';
import { NewsAiReadService } from './services/news-ai-read.service';

/**
 * News AI (2026-11-23): Claude reads every relevant article (job 'news.sentiment', Sonnet, every 2 min)
 * and writes the news page's "what matters now" brief (job 'news.brief', Opus, every 15 min weekdays
 * 08:00-23:30 IST + on demand). Read-only toward trading: stores only news_ai_reads /
 * news_ai_read_failures / news_briefs. NEWS_AI=off disables both jobs.
 */
@Module({
  imports: [PrismaModule, AiGatewayModule, TradeSentinelModule],
  controllers: [NewsAiController],
  providers: [
    { provide: NEWS_AI_CONFIG, useFactory: () => parseNewsAiConfig(process.env) },
    NewsAiRepository,
    { provide: NEWS_AI_STORE, useExisting: NewsAiRepository },
    NewsAiLlmService,
    { provide: NEWS_AI_LLM, useExisting: NewsAiLlmService },
    NewsAiReadService,
    NewsAiBriefService,
  ],
})
export class NewsAiModule {}
