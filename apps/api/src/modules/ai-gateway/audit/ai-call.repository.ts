import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** One `ai_calls` row: exactly the `AiCall` columns minus `id` / `createdAt`. */
export interface AiCallRow {
  job: string;
  provider: string;
  model: string;
  effort: string | null;
  priority: number;
  userId: string | null;
  positionId: string | null;
  setupId: string | null;
  decisionRecordId: string | null;
  requestHash: string;
  request: unknown;
  response: unknown | null;
  errorClass: string | null;
  errorMessage: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costInr: number;
  latencyMs: number;
  queuedMs: number;
  fallbackFrom: string | null;
}

/**
 * The slice of the Prisma client this repository uses, typed locally.
 *
 * Declared here rather than read off `PrismaService` so the module compiles
 * whether or not the shared generated client already carries the SP3 models
 * (several worktrees share one `node_modules`). Runtime needs `prisma generate`
 * against the current schema, as every deploy already runs.
 */
interface AiCallDelegate {
  aiCall: {
    create(args: { data: AiCallRow }): Promise<unknown>;
    aggregate(args: {
      _sum: { costInr: true };
      where: { createdAt: { gte: Date } };
    }): Promise<{ _sum: { costInr: { toString(): string } | number | null } }>;
  };
}

/**
 * Writes the AI call ledger (`ai_calls`, spec §4.6).
 *
 * This repository does NOT swallow errors: a failed write rejects. Failing
 * open is the gateway's job, which never awaits this on the caller's path —
 * keeping the policy in one place makes it testable and keeps this class an
 * honest data-access layer.
 */
@Injectable()
export class AiCallRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db(): AiCallDelegate {
    return this.prisma as unknown as AiCallDelegate;
  }

  async insert(row: AiCallRow): Promise<void> {
    await this.db.aiCall.create({ data: row });
  }

  /** Sum of `costInr` for calls recorded at or after `since`. */
  async spentSince(since: Date): Promise<number> {
    const agg = await this.db.aiCall.aggregate({
      _sum: { costInr: true },
      where: { createdAt: { gte: since } },
    });
    const sum = agg._sum.costInr;
    if (sum === null || sum === undefined) return 0;
    const n = Number(sum.toString());
    return Number.isFinite(n) ? n : 0;
  }
}
