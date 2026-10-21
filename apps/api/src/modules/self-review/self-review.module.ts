import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { parseExitDisciplineConfig } from '../exit-discipline/config';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import { SelfReviewController } from './controllers/self-review.controller';
import { SelfReviewRepository } from './repositories/self-review.repository';
import { VerificationSourcesRepository } from './repositories/verification-sources.repository';
import { parseSelfReviewConfig, SELF_REVIEW_CONFIG } from './self-review.config';
import { SELF_REVIEW_REPORT } from './self-review.ports';
import { SELF_REVIEW_CLOCK, SELF_REVIEW_DEFAULTS, SelfReviewRunService, type TunableDefaults } from './services/self-review-run.service';
import { SelfReviewCron } from './services/self-review.cron';
import { SelfReviewService } from './services/self-review.service';
import { OPENING_GUARD_TARGET, PERSIST_MIN_TARGET } from './tuning/tunables';
import { SelfReviewTuningModule } from './tuning/tuning.module';
import { SelfReviewLearningModule } from './lessons/self-review-learning.module';

/**
 * Self-review loop (docs/superpowers/plans/2026-10-21-self-review-contract.md), stream A: verify →
 * summarise → (diagnose: stream B) → propose; TuningService; REST. SELF_REVIEW_ENABLED (default true).
 * Writes only verification_results / self_review_runs / tuning_proposals / tuning_overrides; never
 * touches risk limits, the kill switch, the hold switch, caps, auto-exit or the broker.
 *
 * Stream B: import the diagnose/lessons modules here, exporting SELF_REVIEW_DIAGNOSIS /
 * SELF_REVIEW_LESSONS (self-review.ports.ts); both are injected @Optional().
 *
 * @Global so the night report can read SELF_REVIEW_REPORT without importing this module.
 */
@Global()
@Module({
  imports: [PrismaModule, SelfReviewTuningModule, SelfReviewLearningModule],
  controllers: [SelfReviewController],
  providers: [
    SelfReviewRepository,
    VerificationSourcesRepository,
    { provide: SELF_REVIEW_CONFIG, useFactory: () => parseSelfReviewConfig(process.env) },
    { provide: SELF_REVIEW_CLOCK, useFactory: () => makeSentinelClock(process.env.HUB_MCX_LATE_CLOSE) },
    {
      // The exit targets' "current value" without an override is the env-parsed exit-discipline config.
      provide: SELF_REVIEW_DEFAULTS,
      useFactory: (): TunableDefaults => {
        const c = parseExitDisciplineConfig(process.env);
        return { [OPENING_GUARD_TARGET]: c.openingGuardMin, [PERSIST_MIN_TARGET]: c.persistMinSec };
      },
    },
    SelfReviewRunService,
    SelfReviewService,
    SelfReviewCron,
    { provide: SELF_REVIEW_REPORT, useExisting: SelfReviewService },
  ],
  exports: [SelfReviewService, SELF_REVIEW_REPORT],
})
export class SelfReviewModule {}
