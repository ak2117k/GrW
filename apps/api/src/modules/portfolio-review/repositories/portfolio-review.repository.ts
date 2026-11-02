import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { LlmSummary, PortfolioReview, ReviewRun, TrackerInput } from '../domain/types';

interface RunRow {
  id: string;
  user_id: string;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  progress: string | null;
  error: string | null;
  review_id: string | null;
}

function toRun(r: RunRow): ReviewRun {
  return {
    id: r.id,
    userId: r.user_id,
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    status: r.status === 'RUNNING' || r.status === 'DONE' ? r.status : 'FAILED',
    progress: r.progress,
    error: r.error,
    reviewId: r.review_id,
  };
}

export interface ReviewHistoryRow {
  id: string;
  createdAt: Date;
  realisedNet: number;
  unrealised: number;
  total: number;
  charges: number;
  trades: number;
  winRate: number;
  summaryStatus: string;
}

/**
 * Reads the caller's real broker book (trade_trackers) and stores / reads the
 * generated reviews (portfolio_reviews, raw SQL like the other observe tables).
 * Every query filters on userId explicitly: trade_trackers is not a tenant-scoped
 * model and ADMIN requests are never auto-scoped.
 */
@Injectable()
export class PortfolioReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listTrackers(userId: string): Promise<TrackerInput[]> {
    return this.prisma.tradeTracker.findMany({
      where: { userId },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        token: true,
        kind: true,
        entryPrice: true,
        qty: true,
        entryTime: true,
        exitPrice: true,
        exitTime: true,
        status: true,
        holdingHigh: true,
        holdingLow: true,
        lastLtp: true,
        pnl: true,
        pnlPercent: true,
        updatedAt: true,
      },
      orderBy: { entryTime: 'asc' },
    });
  }

  async save(review: PortfolioReview): Promise<string> {
    const id = randomUUID();
    const h = review.headline;
    await this.prisma.$executeRaw`
      INSERT INTO "portfolio_reviews"
        ("id", "user_id", "created_at", "realised_net", "unrealised", "total", "charges", "trades", "win_rate", "summary_status", "summary", "payload")
      VALUES
        (${id}, ${review.userId}, ${new Date(review.generatedAt)}, ${h.realisedNet}, ${h.unrealised}, ${h.total}, ${h.charges},
         ${h.trades}, ${h.winRate}, ${review.summary.status}, ${review.summary.text}, ${JSON.stringify(review)}::jsonb)`;
    return id;
  }

  async updateSummary(id: string, userId: string, summary: LlmSummary): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "portfolio_reviews"
         SET "summary_status" = ${summary.status},
             "summary" = ${summary.text},
             "payload" = jsonb_set("payload", '{summary}', ${JSON.stringify(summary)}::jsonb)
       WHERE "id" = ${id} AND "user_id" = ${userId}`;
  }

  /** The newest stored review for the user generated at or after `since`, if any. */
  async latestSince(userId: string, since: Date): Promise<{ id: string; review: PortfolioReview } | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; payload: PortfolioReview }>>`
      SELECT "id", "payload" FROM "portfolio_reviews"
       WHERE "user_id" = ${userId} AND "created_at" >= ${since}
       ORDER BY "created_at" DESC LIMIT 1`;
    return rows[0] ? { id: rows[0].id, review: rows[0].payload } : null;
  }

  /** Fill the action plan's LLM explanation in place when it arrives after the run stored the review. */
  async updatePlanExplanation(id: string, userId: string, explanation: LlmSummary): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "portfolio_reviews"
         SET "payload" = jsonb_set("payload", '{actionPlan,explanation}', ${JSON.stringify(explanation)}::jsonb)
       WHERE "id" = ${id} AND "user_id" = ${userId} AND jsonb_typeof("payload"->'actionPlan') = 'object'`;
  }

  /** The newest stored review for the user (any age), or null. Never computes. */
  async latest(userId: string): Promise<{ id: string; review: PortfolioReview } | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; payload: PortfolioReview }>>`
      SELECT "id", "payload" FROM "portfolio_reviews"
       WHERE "user_id" = ${userId}
       ORDER BY "created_at" DESC LIMIT 1`;
    return rows[0] ? { id: rows[0].id, review: rows[0].payload } : null;
  }

  /** One stored review by id, scoped to the user. */
  async byId(id: string, userId: string): Promise<PortfolioReview | null> {
    const rows = await this.prisma.$queryRaw<Array<{ payload: PortfolioReview }>>`
      SELECT "payload" FROM "portfolio_reviews" WHERE "id" = ${id} AND "user_id" = ${userId} LIMIT 1`;
    return rows[0]?.payload ?? null;
  }

  // --- runs (portfolio_review_runs) -------------------------------------------------------------

  async createRun(run: ReviewRun): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "portfolio_review_runs" ("id", "user_id", "started_at", "status", "progress")
      VALUES (${run.id}, ${run.userId}, ${new Date(run.startedAt)}, ${run.status}, ${run.progress})`;
  }

  async finishRun(
    id: string,
    userId: string,
    patch: { status: ReviewRun['status']; finishedAt: Date; reviewId: string | null; error: string | null; progress: string | null },
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "portfolio_review_runs"
         SET "status" = ${patch.status}, "finished_at" = ${patch.finishedAt}, "review_id" = ${patch.reviewId},
             "error" = ${patch.error}, "progress" = ${patch.progress}
       WHERE "id" = ${id} AND "user_id" = ${userId}`;
  }

  async runById(id: string, userId: string): Promise<ReviewRun | null> {
    const rows = await this.prisma.$queryRaw<RunRow[]>`
      SELECT * FROM "portfolio_review_runs" WHERE "id" = ${id} AND "user_id" = ${userId} LIMIT 1`;
    return rows[0] ? toRun(rows[0]) : null;
  }

  async latestRun(userId: string): Promise<ReviewRun | null> {
    const rows = await this.prisma.$queryRaw<RunRow[]>`
      SELECT * FROM "portfolio_review_runs" WHERE "user_id" = ${userId} ORDER BY "started_at" DESC LIMIT 1`;
    return rows[0] ? toRun(rows[0]) : null;
  }

  /** Runs started since `since` that count toward the monthly quota (RUNNING or DONE). */
  async countRunsSince(userId: string, since: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint | number }>>`
      SELECT COUNT(*) AS n FROM "portfolio_review_runs"
       WHERE "user_id" = ${userId} AND "started_at" >= ${since} AND "status" IN ('RUNNING', 'DONE')`;
    return Number(rows[0]?.n ?? 0);
  }

  async history(userId: string, limit = 30): Promise<ReviewHistoryRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; created_at: Date; realised_net: number; unrealised: number; total: number; charges: number; trades: number; win_rate: number; summary_status: string }>
    >`
      SELECT "id", "created_at", "realised_net", "unrealised", "total", "charges", "trades", "win_rate", "summary_status"
        FROM "portfolio_reviews"
       WHERE "user_id" = ${userId}
       ORDER BY "created_at" DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      realisedNet: Number(r.realised_net),
      unrealised: Number(r.unrealised),
      total: Number(r.total),
      charges: Number(r.charges),
      trades: Number(r.trades),
      winRate: Number(r.win_rate),
      summaryStatus: r.summary_status,
    }));
  }
}
