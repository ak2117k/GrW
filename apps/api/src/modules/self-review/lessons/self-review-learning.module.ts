import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { AiGatewayModule } from '../../ai-gateway/ai-gateway.module';
import { AI_GATEWAY, type AiGateway } from '../../ai-gateway/ai-gateway.service';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import { SentinelGatewayTransport } from '../../ai-gateway/sentinel/sentinel-gateway.transport';
import type { MessagesTransport } from '../../ai-gateway/transport.types';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { DiagnosisService, SELF_REVIEW_DIAGNOSE_JOB, SELF_REVIEW_LLM } from '../diagnose/diagnosis.service';
import { SelfReviewDiagnosisAdapter } from '../diagnose/self-review-diagnosis.adapter';
import { SELF_REVIEW_DIAGNOSIS, SELF_REVIEW_LESSONS } from '../self-review.ports';
import { LessonsService } from './lessons.service';
import { LESSONS_READER } from './types';

/**
 * Self-review learning (stream B): the batched miss diagnosis and the agent lessons.
 *
 * `@Global` so the sentinel's `ContextPacketService` and the overnight scorecard's
 * `NewsIdeasService` can inject the {@link LESSONS_READER} port (`@Optional`) without their
 * modules importing this one — it only has to be imported once (by `SelfReviewModule`).
 * Unimported, both consumers simply see no lessons.
 */
@Global()
@Module({
  imports: [PrismaModule, AiGatewayModule],
  providers: [
    LessonsService,
    { provide: LESSONS_READER, useExisting: LessonsService },
    {
      // The same transport choice as the sentinel's ANTHROPIC_CLIENT (trade-sentinel.module.ts):
      // AI_GATEWAY_SENTINEL=true → the gateway (routed by SENTINEL_JUDGE); else SENTINEL_JUDGE=cli →
      // the local claude CLI; else the Anthropic API — the direct path writing one `ai_calls` row per
      // call (job `self-review.diagnose`) unless AI_CALLS_RECORD=off.
      provide: SELF_REVIEW_LLM,
      useFactory: (config: ConfigService, cli: ClaudeCliTransport, gateway: AiGateway, calls: AiCallRepository): MessagesTransport =>
        config.get<string>('AI_GATEWAY_SENTINEL')?.trim().toLowerCase() === 'true'
          ? new SentinelGatewayTransport(gateway)
          : directRecordedTransport({
              judge: judgeTransportFrom(config.get<string>('SENTINEL_JUDGE')),
              cli,
              apiKey: config.get<string>('ANTHROPIC_API_KEY'),
              record: aiCallsRecordingOn(config.get<string>('AI_CALLS_RECORD')),
              audit: calls,
              jobOf: () => SELF_REVIEW_DIAGNOSE_JOB,
            }),
      inject: [ConfigService, ClaudeCliTransport, AI_GATEWAY, AiCallRepository],
    },
    DiagnosisService,
    // Stream A's ports (self-review.ports.ts): the nightly run diagnoses + upserts lessons through
    // the adapter; the lessons tab retires through LessonsService.
    SelfReviewDiagnosisAdapter,
    { provide: SELF_REVIEW_DIAGNOSIS, useExisting: SelfReviewDiagnosisAdapter },
    { provide: SELF_REVIEW_LESSONS, useExisting: LessonsService },
  ],
  exports: [LessonsService, LESSONS_READER, DiagnosisService, SELF_REVIEW_DIAGNOSIS, SELF_REVIEW_LESSONS],
})
export class SelfReviewLearningModule {}
