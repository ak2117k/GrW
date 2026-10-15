// apps/api/src/modules/sentinel-executor/repositories/ai-exit-outcome.repository.ts
import { Injectable } from '@nestjs/common';
import { Prisma, type AiExitOutcome } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ExitOutcomeValues } from '../../exit-discipline/outcome';
import type { OutcomeKind, PositionSide } from '../../exit-discipline/types';
import { MANUAL_VERDICT_PREFIX } from '../domain/manual-exit';

/** Price-trigger verdict ids (sentinel price triggers): scored, never written to the corpus (plan M4). */
export const TRIGGER_VERDICT_PREFIX = 'trg_';
const IST_OFFSET_MS = 330 * 60_000;

export interface PendingOutcome {
  executionId: string; userId: string; verdictId: string; trackerId: string;
  symbol: string; exchange: string; token: string;
  kind: OutcomeKind; positionSide: PositionSide; qty: number;
  decisionPrice: number; decisionAt: Date; windowEnd: Date; status: 'PENDING';
}

/** Exit discipline §8: `ai_exit_outcomes`, one row per scored ai_exit_executions row. No FK. */
@Injectable()
export class AiExitOutcomeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Insert the PENDING row. A row for the execution already existing is a no-op. */
  async createPending(row: PendingOutcome): Promise<void> {
    try {
      await this.prisma.aiExitOutcome.create({ data: row });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
  }

  /** PENDING rows whose window ended at least 2 min ago (the last bar has closed), oldest first. */
  due(now: Date, limit = 10): Promise<AiExitOutcome[]> {
    return this.prisma.aiExitOutcome.findMany({
      where: { status: 'PENDING', windowEnd: { lte: new Date(now.getTime() - 120_000) } },
      orderBy: { windowEnd: 'asc' },
      take: limit,
    });
  }

  async markDone(id: string, values: ExitOutcomeValues, dataSource: string, note: string | null, at: Date = new Date()): Promise<void> {
    await this.prisma.aiExitOutcome.update({
      where: { id },
      data: { ...values, status: 'DONE', dataSource, note, computedAt: at, attempts: { increment: 1 } },
    });
  }

  async markRetry(id: string, note: string): Promise<void> {
    await this.prisma.aiExitOutcome.update({ where: { id }, data: { attempts: { increment: 1 }, note } });
  }

  async markNoData(id: string, note: string, at: Date = new Date()): Promise<void> {
    await this.prisma.aiExitOutcome.update({
      where: { id },
      data: { status: 'NO_DATA', note, computedAt: at, attempts: { increment: 1 } },
    });
  }

  /** DONE outcomes of plain AI verdicts (neither manual nor price-trigger) not yet merged into the SP3 corpus. */
  corpusPending(since: Date, limit = 20): Promise<AiExitOutcome[]> {
    return this.prisma.aiExitOutcome.findMany({
      where: {
        status: 'DONE', corpusAt: null, decisionAt: { gte: since },
        NOT: [{ verdictId: { startsWith: MANUAL_VERDICT_PREFIX } }, { verdictId: { startsWith: TRIGGER_VERDICT_PREFIX } }],
      },
      orderBy: { decisionAt: 'asc' },
      take: limit,
    });
  }

  async markCorpus(id: string, at: Date): Promise<void> {
    await this.prisma.aiExitOutcome.update({ where: { id }, data: { corpusAt: at } });
  }

  /** The user's DONE outcomes decided during IST day `day` ('YYYY-MM-DD'). */
  forDay(userId: string, day: string): Promise<AiExitOutcome[]> {
    const start = new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
    return this.prisma.aiExitOutcome.findMany({
      where: { userId, status: 'DONE', decisionAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) } },
      orderBy: { decisionAt: 'asc' },
    });
  }

  /** One query for a page of executions (the AI exits list). */
  async byExecutionIds(ids: string[]): Promise<AiExitOutcome[]> {
    if (ids.length === 0) return [];
    return this.prisma.aiExitOutcome.findMany({ where: { executionId: { in: ids } } });
  }
}
