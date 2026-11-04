import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { SELF_REVIEW_OPS_ALERT, type OpsAlertFn } from './decision-loop.ports';
import { FixTicketRepository } from './fix-ticket.repository';

/**
 * The wrong-decision loop's G1 side (2026-11-04): fix tickets and the ops alert sender. `@Global` so the night
 * report can read the loop's ports without importing the self-review module. Imported once, by
 * SelfReviewLearningModule (itself imported by SelfReviewModule).
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    FixTicketRepository,
    { provide: SELF_REVIEW_OPS_ALERT, useValue: ((key: string, text: string) => sendOpsAlert(key, text)) satisfies OpsAlertFn },
  ],
  exports: [FixTicketRepository, SELF_REVIEW_OPS_ALERT],
})
export class SelfReviewTicketsModule {}
