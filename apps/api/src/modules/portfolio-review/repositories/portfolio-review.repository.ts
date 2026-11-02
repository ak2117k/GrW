import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { LlmSummary, PortfolioReview, TrackerInput } from '../domain/types';

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
