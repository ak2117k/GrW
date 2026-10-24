import { Module } from '@nestjs/common';
import { AiAssistModule } from '../ai-assist/ai-assist.module';
import { TradeCoreModule } from '../trade-core/trade-core.module';
import { StrategyBuilderAiController } from './controllers/strategy-builder-ai.controller';
import { StrategyAiService } from './services/strategy-ai.service';

/**
 * Strategy Builder: deterministic validation for everyone, and the owner-only
 * Claude review / auto-suggest over the existing Claude session (AiAssistModule's
 * AssistLlmService — the shared, non-reserved sentinel slot; ai_calls jobs
 * `strategy.review` / `strategy.suggest`). Sizing is checked against the user's
 * own Risk Wall limits (TradeCoreModule's CoreRiskLimitService).
 */
@Module({
  imports: [AiAssistModule, TradeCoreModule],
  controllers: [StrategyBuilderAiController],
  providers: [StrategyAiService],
})
export class StrategyBuilderAiModule {}
