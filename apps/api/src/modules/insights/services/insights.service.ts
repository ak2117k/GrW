import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InsightsRepository } from '../repositories/insights.repository';
import { Prisma, AIInsight } from '@prisma/client';

const STALE_IN_PROGRESS_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING_BATCH = 10;

/** Who asked for an insight — the authenticated principal, when there is one. */
export interface InsightRequester {
  userId: string;
  role?: string;
}

/**
 * Serves a section in-process instead of leaving its rows for the MCP
 * `get_pending_insights` loop. Returns `false` to decline (the row then stays
 * pending for the MCP loop, exactly as before). Once it returns `true` it owns
 * the row and must mark it completed or failed.
 */
export type InsightProcessor = (row: AIInsight, requester: InsightRequester | undefined) => boolean;

@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);
  private readonly processors = new Map<string, InsightProcessor>();
  private readonly userScoped = new Set<string>();

  constructor(private readonly repo: InsightsRepository) {}

  /**
   * Register the in-process processor for one section (one per section).
   *
   * `userScoped: true` — the answer embeds the REQUESTER's private data (e.g.
   * the news analysis reads their open positions), so the section's rows are
   * keyed per user: one user can never be handed, or read, another's row.
   */
  registerProcessor(sectionKey: string, processor: InsightProcessor, opts: { userScoped?: boolean } = {}): void {
    this.processors.set(sectionKey, processor);
    if (opts.userScoped) this.userScoped.add(sectionKey);
    else this.userScoped.delete(sectionKey);
  }

  /**
   * The stored contextKey. For a user-scoped section the requester's id is
   * folded in (`<key>@u:<userId>`), on BOTH the write and the read path; a
   * request without an authenticated user gets its own `anon` bucket.
   */
  scopedContextKey(sectionKey: string, contextKey: string, requester?: InsightRequester): string {
    if (!this.userScoped.has(sectionKey)) return contextKey;
    return `${contextKey}@u:${requester?.userId || 'anon'}`;
  }

  /**
   * Idempotent: if a row with same (sectionKey, contextKey) is already
   * pending or in_progress, returns it instead of creating a new one.
   *
   * A section with a registered processor is handed the new row straight away
   * (fire-and-forget — the request returns the pending row and the card polls).
   */
  async requestInsight(
    sectionKey: string,
    rawContextKey: string,
    contextData: Prisma.InputJsonValue,
    requester?: InsightRequester,
  ): Promise<AIInsight> {
    const contextKey = this.scopedContextKey(sectionKey, rawContextKey, requester);
    const existing = await this.repo.findActiveByKey(sectionKey, contextKey);
    if (existing) {
      this.logger.log(`Returning existing active insight ${existing.id} for ${sectionKey}/${contextKey}`);
      return existing;
    }
    const row = await this.repo.create({ sectionKey, contextKey, contextData });
    const processor = this.processors.get(sectionKey);
    if (processor) {
      try {
        processor(row, requester);
      } catch (err) {
        this.logger.error(`Insight processor for ${sectionKey} threw: ${err instanceof Error ? err.message : err}`);
      }
    }
    return row;
  }

  /**
   * Latest insight for a key, or null when none was ever requested. "Never
   * asked" is the normal first state of every insight card, not an error —
   * answering it with 404 put a red "Failed to load resource" line in the
   * console on every page view (e.g. /api/insights/options-chain/NIFTY%3A2026-10-27).
   */
  async findLatest(sectionKey: string, contextKey: string, requester?: InsightRequester): Promise<AIInsight | null> {
    return this.repo.findLatestByKey(sectionKey, this.scopedContextKey(sectionKey, contextKey, requester));
  }

  /** Mark a row in progress (an in-process processor taking it). */
  async startInsight(id: string): Promise<AIInsight> {
    return this.repo.markInProgress(id);
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
