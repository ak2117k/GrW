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
import {
  CARRY_DECIDE_BY_TARGET,
  FLOOR_ARM_N_TARGET,
  FLOOR_TRAIL_N_TARGET,
  JUDGE_DEFAULT_TAKE_TARGET,
  JUDGE_MIN_CONFIDENCE_TARGET,
  OPENING_GUARD_TARGET,
  PERSIST_MIN_TARGET,
  SPIKE_BANK_RISE_N_TARGET,
  SPIKE_BANK_TRAIL_N_TARGET,
} from './tuning/tunables';
import { SelfReviewTuningModule } from './tuning/tuning.module';
import { SelfReviewLearningModule } from './lessons/self-review-learning.module';
import { DecisionsModule } from './decisions/decisions.module';
import { AutoApplyCron } from './auto-apply/auto-apply.cron';
import { AUTO_APPLY_CONFIG, DECISION_PNL, parseAutoApplyConfig } from './auto-apply/auto-apply.ports';
import { DecisionGradeRepository } from './decisions/decision-grade.repository';
import { AutoApplyRepository } from './auto-apply/auto-apply.repository';
import { AutoApplyService } from './auto-apply/auto-apply.service';
import { parseSignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { parseCarryConfig } from '../intraday-carry/domain/carry-config';
import { SPIKE_BANK_RISE_N, SPIKE_BANK_TRAIL_N } from '../exit-discipline/config';

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
  // DecisionsModule (2026-11-04 stream F): the decision ledger — exports DecisionGradingService / DecisionGradeRepository.
  imports: [PrismaModule, SelfReviewTuningModule, SelfReviewLearningModule, DecisionsModule],
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
        // 2026-11-05: the wrong-decision loop's tunables default to the consumers' env values.
        const sig = parseSignalTraderConfig(process.env);
        return {
          [OPENING_GUARD_TARGET]: c.openingGuardMin,
          [PERSIST_MIN_TARGET]: c.persistMinSec,
          [JUDGE_MIN_CONFIDENCE_TARGET]: sig.judgeMinConfidence,
          [JUDGE_DEFAULT_TAKE_TARGET]: sig.judgeDefault === 'take',
          [FLOOR_ARM_N_TARGET]: c.floorArmN,
          [FLOOR_TRAIL_N_TARGET]: c.floorTrailN,
          [SPIKE_BANK_RISE_N_TARGET]: SPIKE_BANK_RISE_N,
          [SPIKE_BANK_TRAIL_N_TARGET]: SPIKE_BANK_TRAIL_N,
          [CARRY_DECIDE_BY_TARGET]: parseCarryConfig(process.env).decideByMin,
        };
      },
    },
    // Auto-apply watches and directs changes from stream F's graded decisions (perDecisionPnl / wrongSince).
    { provide: DECISION_PNL, useExisting: DecisionGradeRepository },
    SelfReviewRunService,
    SelfReviewService,
    SelfReviewCron,
    // 2026-11-05 wrong-decision loop G2: auto-apply + watch/rollback (SELF_REVIEW_AUTO_APPLY=on|off, default on).
    { provide: AUTO_APPLY_CONFIG, useFactory: () => parseAutoApplyConfig(process.env) },
    AutoApplyRepository,
    AutoApplyService,
    AutoApplyCron,
    { provide: SELF_REVIEW_REPORT, useExisting: SelfReviewService },
  ],
  exports: [SelfReviewService, SELF_REVIEW_REPORT, AutoApplyService],
})
export class SelfReviewModule {}
