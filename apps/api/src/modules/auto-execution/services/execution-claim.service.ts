import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** Input for a claim attempt — one row per (signal, user). */
export interface ClaimInput {
  /** sha256(entryId:userId) — computed upstream (TDA-010), stable across retries. */
  idempotencyKey: string;
  userId: string;
  entryId: string;
}

/** Result of a claim attempt. `acquired: false` == someone already claimed. */
export interface ClaimResult {
  acquired: boolean;
}

/** ExecutionClaim lifecycle. Kept as strings to match the Prisma `status` column. */
export const ExecutionClaimStatus = {
  CLAIMED: 'CLAIMED',
  PLACED: 'PLACED',
  FAILED: 'FAILED',
} as const;

/**
 * Local idempotency store for the per-user auto-execution pipeline (TDA-011 §5).
 *
 * The bias is **at-most-once**: `claim` inserts a `CLAIMED` row BEFORE any side
 * effect (credential decrypt / broker order). The `@unique(idempotencyKey)`
 * constraint on `ExecutionClaim` is the concurrency backstop — two concurrent
 * jobs with the same key race the INSERT; exactly one wins (`acquired: true`),
 * the loser catches the P2002 unique violation and is told `acquired: false`
 * (the caller silently skips — no second order). A crash between `claim` and the
 * order therefore errs toward a MISSED order, never a duplicate real-money one.
 *
 * `markPlaced` / `markFailed` settle the row after placement. A row stuck in
 * `CLAIMED` (crash-in-window) is intentionally NOT auto-retried into a second
 * order; reconciliation of `CLAIMED`-but-unsettled rows is a TDA-012 concern.
 *
 * NOT a tenant-scoped model: the queue worker writes it cross-user with no
 * request context, so it is deliberately absent from `TENANT_MODELS`.
 */
@Injectable()
export class ExecutionClaimService {
  private readonly logger = new Logger(ExecutionClaimService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attempt to claim (signal, user). Inserts a `CLAIMED` row; on a duplicate the
   * unique constraint raises P2002, which is caught and reported as
   * `{ acquired: false }`. Never throws on a duplicate — a duplicate is the
   * normal, expected outcome of a retried / double-delivered job.
   */
  async claim(input: ClaimInput): Promise<ClaimResult> {
    try {
      await this.prisma.executionClaim.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          userId: input.userId,
          entryId: input.entryId,
          status: ExecutionClaimStatus.CLAIMED,
        },
      });
      return { acquired: true };
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.debug(
          `Duplicate execution claim skipped for key=${input.idempotencyKey}`,
        );
        return { acquired: false };
      }
      throw err;
    }
  }

  /** Settle a claim as PLACED, recording the broker order id. */
  async markPlaced(idempotencyKey: string, brokerOrderId: string): Promise<void> {
    await this.prisma.executionClaim.update({
      where: { idempotencyKey },
      data: {
        status: ExecutionClaimStatus.PLACED,
        brokerOrderId,
        error: null,
      },
    });
  }

  /** Settle a claim as FAILED, recording the error reason. */
  async markFailed(idempotencyKey: string, error: string): Promise<void> {
    await this.prisma.executionClaim.update({
      where: { idempotencyKey },
      data: {
        status: ExecutionClaimStatus.FAILED,
        error,
      },
    });
  }
}

/** True when `err` is a Prisma P2002 unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
