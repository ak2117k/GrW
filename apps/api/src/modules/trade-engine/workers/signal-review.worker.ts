import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { Prisma } from '@prisma/client';
import { InsightsService } from '../../insights/services/insights.service';
import { TradeExecutionService } from '../services/trade-execution.service';
import { TradeRepository } from '../repositories/trade.repository';

/**
 * Job payload for `review-trade` on the `signal-review` queue.
 *
 * After the universe scanner places a paper trade, it enqueues one of these
 * jobs. The worker asks Claude (via the /insights queue) whether it would
 * have approved the trade. If Claude rejects, the position is squared off
 * immediately. Warnings and approvals are logged only.
 */
export interface ReviewTradeJobData {
  tradeId: string;
  signal: Record<string, any>;
  snapshot: {
    strikePrice?: number;
    side?: string;
    ltp?: number;
    oi?: number;
    gamma?: number;
    [k: string]: any;
  };
}

type Verdict = 'APPROVE' | 'WARN' | 'REJECT' | 'TIMEOUT';

const SECTION_KEY = 'trade-review';
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 36; // ~3 minutes
const REVIEW_QUESTION =
  'This trade was just placed automatically by the rule. Review whether you ' +
  'would have approved it. End your response with VERDICT: APPROVE, VERDICT: ' +
  'WARN, or VERDICT: REJECT on its own line.';

@Processor('signal-review')
export class SignalReviewWorker {
  private readonly logger = new Logger(SignalReviewWorker.name);

  constructor(
    private readonly insightsService: InsightsService,
    private readonly tradeExecutionService: TradeExecutionService,
    private readonly tradeRepository: TradeRepository,
  ) {}

  @Process({ name: 'review-trade', concurrency: 2 })
  async reviewTrade(job: Job): Promise<void> {
    const { tradeId, signal, snapshot } = job.data as ReviewTradeJobData;
    this.logger.debug(
      `Processing signal-review job ${job.id} for trade ${tradeId}`,
    );

    try {
      // 1. Look up the trade so we can enrich the review payload.
      const trade = await this.tradeRepository.getTradeById(tradeId);
      if (!trade) {
        this.logger.warn(
          `Trade ${tradeId} not found - aborting signal-review job ${job.id}`,
        );
        return;
      }

      // 2. Post the context to the /insights queue (idempotent on contextKey).
      const contextData: Prisma.InputJsonValue = {
        trade: {
          id: trade.id,
          symbol: (trade as any).instrument?.symbol ?? null,
          side: trade.side,
          quantity: trade.quantity,
          entryPrice: trade.entryPrice ?? null,
          strategy: trade.strategy ?? null,
          isPaper: trade.isPaperTrade,
        },
        signal,
        selectedStrike: snapshot,
        question: REVIEW_QUESTION,
        capturedAt: new Date().toISOString(),
      };

      await this.insightsService.requestInsight(
        SECTION_KEY,
        tradeId,
        contextData,
      );
      this.logger.log(
        `Submitted trade-review insight for trade ${tradeId} - polling for verdict`,
      );

      // 3. Poll for completion.
      const insight = await this.pollForCompletion(tradeId);

      if (!insight) {
        this.logger.warn(
          `Trade-review for ${tradeId} timed out after ~${
            (POLL_INTERVAL_MS * MAX_POLL_ATTEMPTS) / 1000
          }s - leaving trade open`,
        );
        await this.persistReview(tradeId, {
          verdict: 'TIMEOUT',
          reasoning: null,
          reviewedAt: new Date().toISOString(),
        });
        return;
      }

      if (insight.status === 'failed') {
        this.logger.warn(
          `Trade-review insight for ${tradeId} failed: ${
            (insight as any).errorMessage ?? 'unknown error'
          }`,
        );
        await this.persistReview(tradeId, {
          verdict: 'TIMEOUT',
          reasoning: `Insight failed: ${
            (insight as any).errorMessage ?? 'unknown'
          }`,
          reviewedAt: new Date().toISOString(),
        });
        return;
      }

      // 4. Parse Claude's verdict from the returned markdown.
      const markdown: string = (insight as any).insight ?? '';
      const verdict = this.parseVerdict(markdown);
      const preview = markdown.slice(0, 200).replace(/\s+/g, ' ').trim();
      this.logger.log(
        `Trade ${tradeId} review verdict: ${verdict} - "${preview}"`,
      );

      await this.persistReview(tradeId, {
        verdict,
        reasoning: markdown,
        reviewedAt: new Date().toISOString(),
      });

      // 5. Act on the verdict.
      if (verdict === 'REJECT') {
        this.logger.warn(
          `Claude rejected trade ${tradeId} - closing position immediately`,
        );
        try {
          await this.tradeExecutionService.closeTrade(
            tradeId,
            'Claude review: rejected',
          );
        } catch (closeErr) {
          this.logger.error(
            `Failed to close trade ${tradeId} after REJECT verdict: ${
              closeErr instanceof Error ? closeErr.message : closeErr
            }`,
          );
          throw closeErr;
        }
      } else if (verdict === 'WARN') {
        this.logger.warn(
          `Claude flagged trade ${tradeId} with WARN - no action taken, see review log`,
        );
      } else {
        this.logger.log(
          `Claude approved trade ${tradeId} - no action needed`,
        );
      }
    } catch (error) {
      this.logger.error(
        `signal-review job ${job.id} (trade ${tradeId}) failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
      throw error;
    }
  }

  /**
   * Poll InsightsService.getLatest until the row is completed or failed,
   * or until MAX_POLL_ATTEMPTS is reached. Returns null on timeout.
   */
  private async pollForCompletion(tradeId: string): Promise<any | null> {
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      await this.sleep(POLL_INTERVAL_MS);
      try {
        const row = await this.insightsService.getLatest(SECTION_KEY, tradeId);
        if (row.status === 'completed' || row.status === 'failed') {
          return row;
        }
      } catch (err) {
        this.logger.debug(
          `Poll attempt ${attempt}/${MAX_POLL_ATTEMPTS} for ${tradeId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
    return null;
  }

  /**
   * Parse Claude's verdict from the returned markdown.
   *
   * Primary: look for the magic line `VERDICT: APPROVE|WARN|REJECT`.
   * Fallback: keyword scan - counts approval vs rejection keywords.
   * Ambiguous responses default to WARN.
   */
  private parseVerdict(markdown: string): Verdict {
    if (!markdown || typeof markdown !== 'string') {
      return 'WARN';
    }

    const magic = /VERDICT:\s*(APPROVE|WARN|REJECT)/i.exec(markdown);
    if (magic) {
      return magic[1].toUpperCase() as Verdict;
    }

    const lower = markdown.toLowerCase();
    const approvalHits =
      this.countOccurrences(lower, 'approve') +
      this.countOccurrences(lower, 'good') +
      this.countOccurrences(lower, 'fire');
    const rejectionHits =
      this.countOccurrences(lower, 'reject') +
      this.countOccurrences(lower, 'bad') +
      this.countOccurrences(lower, 'skip') +
      this.countOccurrences(lower, 'stop');

    if (rejectionHits > approvalHits && rejectionHits > 0) {
      return 'REJECT';
    }
    if (approvalHits > rejectionHits && approvalHits > 0) {
      return 'APPROVE';
    }
    return 'WARN';
  }

  private countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
      count++;
      idx += needle.length;
    }
    return count;
  }

  /**
   * Persist the review result on the trade row. The schema does not
   * currently have a dedicated `claudeReview` JSON column, so we stash the
   * payload into the existing `notes` field (the repository's update path
   * supports it) without creating a migration.
   */
  private async persistReview(
    tradeId: string,
    review: { verdict: Verdict; reasoning: string | null; reviewedAt: string },
  ): Promise<void> {
    try {
      const existing = await this.tradeRepository.getTradeById(tradeId);
      const prevNotes = existing?.notes ?? '';
      const marker = '\n\n[claudeReview]';
      const base = prevNotes.includes(marker)
        ? prevNotes.slice(0, prevNotes.indexOf(marker))
        : prevNotes;
      const merged = `${base}${marker} ${JSON.stringify(review)}`;
      await this.tradeRepository.updateTrade(tradeId, { notes: merged });
    } catch (err) {
      this.logger.warn(
        `Could not persist claudeReview for trade ${tradeId}: ${
          err instanceof Error ? err.message : err
        } - verdict=${review.verdict}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
