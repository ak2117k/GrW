import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { InsightsModule } from '../insights/insights.module';
import { NightReportModule } from '../night-report/night-report.module';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { AdvisorChatService } from './advisor-chat.service';
import { AdvisorMemoryRepository } from './advisor-memory';
import { AssistContextService } from './assist-context.service';
import { AssistLlmService } from './assist-llm.service';
import { NewsInsightProcessor } from './news-insight.processor';

/**
 * User-facing Claude calls (News "Ask Claude to analyze", AI Trading Advisor).
 *
 * Reuses the sentinel's transport (`ClaudeCliTransport` from the AI gateway,
 * chosen by `SENTINEL_JUDGE`) and its judge cap (`SentinelCycleService.runShared`
 * — never the live reserved slot). Owner-only; read-only context; no orders, no
 * settings. See `assist-slot.ts` for the slot rules.
 */
@Module({
  imports: [PrismaModule, AiGatewayModule, InsightsModule, TradeSentinelModule, NightReportModule],
  providers: [AssistLlmService, AssistContextService, NewsInsightProcessor, AdvisorChatService, AdvisorMemoryRepository],
  exports: [AdvisorChatService, AssistLlmService],
})
export class AiAssistModule {}
