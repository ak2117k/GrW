import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { CoreCorpusPort } from './journal-ports';
import type { CorpusSetup } from './journal.types';

/**
 * O9 / J20: the core's rows in SP3's provider-neutral decision corpus (SP3 spec §5.1). One ENTRY_SETUP
 * per intent (taken or skipped), first write wins, except that a taken setup replaces a skipped one (an
 * intent that skipped and opened when the alert came round again is labelled taken); outcomes are merged key by key so the close (Task 11)
 * and the price follow-ups (Task 13) never overwrite each other. SP3's DecisionPipeline will write
 * the same (source, sourceId) for intents it produces; the upsert keeps whichever came first.
 */
@Injectable()
export class CoreCorpusWriter implements CoreCorpusPort {
  constructor(private readonly prisma: PrismaService) {}

  async entrySetup(s: CorpusSetup): Promise<void> {
    await this.prisma.aiDecisionRecord.upsert({
      where: { source_sourceId: { source: 'core', sourceId: s.intentId } },
      create: {
        userId: s.userId,
        source: 'core',
        sourceId: s.intentId,
        kind: 'ENTRY_SETUP',
        decidedAt: s.decidedAt,
        symbol: s.symbol,
        exchange: s.exchange,
        direction: s.direction,
        vehicle: s.vehicle,
        strategyKey: s.strategyKey,
        strategyVersionId: s.strategyVersionId,
        setupGroupKey: s.setupGroupKey,
        evidence: s.evidence as Prisma.InputJsonValue,
        ruleScore: s.ruleScore,
        decision: s.decision as unknown as Prisma.InputJsonValue,
      },
      // A skip never overwrites; a taken setup upgrades an earlier skip of the same intent.
      update: s.decision.taken
        ? {
            decidedAt: s.decidedAt,
            setupGroupKey: s.setupGroupKey,
            evidence: s.evidence as Prisma.InputJsonValue,
            ruleScore: s.ruleScore,
            decision: s.decision as unknown as Prisma.InputJsonValue,
          }
        : {},
    });
  }

  async outcome(intentId: string, patch: Record<string, unknown>, at: Date): Promise<void> {
    await this.prisma.$executeRaw`UPDATE "ai_decision_records" SET "outcome" = COALESCE("outcome", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, "outcomeAt" = ${at} WHERE "source" = 'core' AND "sourceId" = ${intentId}`;
  }
}
