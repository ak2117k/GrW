import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { MarketEventsRepository } from '../../news-events/events/market-events.repository';
import { DecisionGradeRepository } from './decision-grade.repository';
import { DecisionGradingService } from './decision-grading.service';
import { DecisionSourcesRepository } from './decision-sources.repository';

/**
 * The decision ledger (plan 2026-11-04 stream F): DecisionGradingService.gradeSession writes
 * `decision_grades`; DecisionGradeRepository.wrongSince / perDecisionPnl are what G1 and G2 read.
 * Read-only over the trading tables; no cron of its own — the self-review run calls gradeSession.
 * MarketEventsRepository is a stateless Prisma reader, provided here so the event detector needs no
 * news-events module import. SELF_REVIEW_DECISION_LOOP=off ⇒ gradeSession writes nothing.
 */
@Module({
  imports: [PrismaModule],
  providers: [DecisionSourcesRepository, DecisionGradeRepository, DecisionGradingService, MarketEventsRepository],
  exports: [DecisionGradingService, DecisionGradeRepository],
})
export class DecisionsModule {}
