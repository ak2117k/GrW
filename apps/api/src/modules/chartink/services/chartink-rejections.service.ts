import { Injectable } from '@nestjs/common';
import { ChartinkRepository } from '../repositories/chartink.repository';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface GetRejectionsParams {
  from?: string;
  to?: string;
  kind?: string;
  limit?: number;
}

export interface RejectionScoreCheck {
  name: string;
  points: number;
  pointsPossible: number;
  passed: boolean;
}

export interface RejectionRow {
  id: string;
  processedAt: string;
  symbol: string;
  scanner: string;
  kind: string;
  reason: string;
  score: number | null;
  hitPrice: number;
  scoreBreakdown: RejectionScoreCheck[] | null;
}

export interface RejectionsResponse {
  range: { from: string; to: string };
  summary: {
    totalProcessed: number;
    accepted: number;
    rejected: number;
    byKind: Array<{ kind: string; count: number }>;
  };
  rejections: RejectionRow[];
}

const DEFAULT_LIMIT = 200;

/**
 * Surfaces and aggregates Chartink alert setups that did NOT result in a trade.
 * Every Chartink stock that doesn't trade is persisted as a ChartinkAlertSetup
 * row; this service reads those rows and produces rejection analytics.
 */
@Injectable()
export class ChartinkRejectionsService {
  constructor(private readonly repo: ChartinkRepository) {}

  /**
   * IST (Asia/Kolkata, UTC+5:30) start of today, returned as a UTC instant.
   */
  private static istStartOfToday(now: Date = new Date()): Date {
    const istNow = new Date(now.getTime() + IST_OFFSET_MS);
    const istMidnight = Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate(),
    );
    // IST midnight expressed as a UTC instant is IST midnight - 5h30m.
    return new Date(istMidnight - IST_OFFSET_MS);
  }

  async getRejections(params: GetRejectionsParams): Promise<RejectionsResponse> {
    const now = new Date();
    const from = params.from ? new Date(params.from) : ChartinkRejectionsService.istStartOfToday(now);
    const to = params.to ? new Date(params.to) : now;
    const limit = params.limit != null && params.limit > 0 ? params.limit : DEFAULT_LIMIT;

    const [rows, grouped] = await Promise.all([
      this.repo.findAlertSetupsInRange({ from, to, kind: params.kind, limit }),
      this.repo.countAlertSetupsByKind({ from, to }),
    ]);

    let totalProcessed = 0;
    let accepted = 0;
    const byKind: Array<{ kind: string; count: number }> = [];
    for (const g of grouped) {
      const count = g._count?._all ?? 0;
      totalProcessed += count;
      if (g.kind === 'setup') {
        accepted += count;
      } else {
        byKind.push({ kind: g.kind, count });
      }
    }
    byKind.sort((a, b) => b.count - a.count);

    const rejections: RejectionRow[] = rows
      .filter((r) => r.kind !== 'setup')
      .map((r) => ({
        id: r.id,
        processedAt: r.processedAt.toISOString(),
        symbol: r.symbol,
        scanner: r.alert?.scanner?.scanName ?? '',
        kind: r.kind,
        reason: r.rejectReason ?? '',
        score: r.score ?? null,
        hitPrice: r.hitPrice,
        // Forward the persisted breakdown verbatim. The column is `Json?` in
        // Prisma — when it isn't an array (missing or a corrupted scalar) we
        // emit null so the frontend's per-factor renderer can fall back to "·".
        scoreBreakdown: Array.isArray(r.scoreBreakdown)
          ? (r.scoreBreakdown as RejectionScoreCheck[])
          : null,
      }));

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        totalProcessed,
        accepted,
        rejected: totalProcessed - accepted,
        byKind,
      },
      rejections,
    };
  }
}
