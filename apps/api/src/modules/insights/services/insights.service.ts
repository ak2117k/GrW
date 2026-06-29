import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InsightsRepository } from '../repositories/insights.repository';
import { Prisma, AIInsight } from '@prisma/client';

const STALE_IN_PROGRESS_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING_BATCH = 10;

@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);

  constructor(private readonly repo: InsightsRepository) {}

  /**
   * Idempotent: if a row with same (sectionKey, contextKey) is already
   * pending or in_progress, returns it instead of creating a new one.
   */
  async requestInsight(
    sectionKey: string,
    contextKey: string,
    contextData: Prisma.InputJsonValue,
  ): Promise<AIInsight> {
    const existing = await this.repo.findActiveByKey(sectionKey, contextKey);
    if (existing) {
      this.logger.log(`Returning existing active insight ${existing.id} for ${sectionKey}/${contextKey}`);
      return existing;
    }
    return this.repo.create({ sectionKey, contextKey, contextData });
  }

  async getLatest(sectionKey: string, contextKey: string): Promise<AIInsight> {
    const row = await this.repo.findLatestByKey(sectionKey, contextKey);
    if (!row) {
      throw new NotFoundException(`No insight found for ${sectionKey}/${contextKey}`);
    }
    return row;
  }

  /**
   * Atomic claim: reverts stale in_progress rows, then claims up to N pending rows.
   * Used by the MCP `get_pending_insights` tool.
   */
  async claimPending(limit = MAX_PENDING_BATCH): Promise<AIInsight[]> {
    const reverted = await this.repo.revertStaleInProgress(
      new Date(Date.now() - STALE_IN_PROGRESS_MS),
    );
    if (reverted > 0) {
      this.logger.warn(`Reverted ${reverted} stale in_progress insights to pending`);
    }

    const pending = await this.repo.findPending(limit);
    const claimed: AIInsight[] = [];
    for (const row of pending) {
      try {
        const updated = await this.repo.markInProgress(row.id);
        claimed.push(updated);
      } catch (err) {
        // Race: someone else claimed it. Skip.
        this.logger.warn(`Failed to claim ${row.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return claimed;
  }

  async completeInsight(id: string, content: string, confidence: number): Promise<AIInsight> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Insight ${id} not found`);
    }
    if (row.status !== 'in_progress') {
      throw new BadRequestException(
        `Insight ${id} is in status '${row.status}', expected 'in_progress'`,
      );
    }
    if (confidence < 1 || confidence > 100) {
      throw new BadRequestException('confidence must be between 1 and 100');
    }
    return this.repo.markCompleted(id, content, confidence);
  }

  async failInsight(id: string, errorMessage: string): Promise<AIInsight> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Insight ${id} not found`);
    }
    return this.repo.markFailed(id, errorMessage);
  }
}
