import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalize, sha256 } from './canonicalize';
import { AuditAction } from './audit-actions';

/**
 * Prisma error codes that mean "another appender on this chain won the race;
 * retry with a fresh snapshot is safe and will succeed":
 *  - P2034: transaction write-conflict / deadlock / serialization failure
 *           (Postgres SQLSTATE 40001 / 40P01).
 *  - P2002: unique-constraint violation on `@@unique([chainKey, seq])`.
 *
 * Under SERIALIZABLE the per-chain advisory lock serialises execution, but a
 * blocked transaction's snapshot is taken BEFORE the holder commits, so on
 * unblock it can read a stale head and collide. Re-running the whole
 * transaction takes a fresh snapshot (the lock is now free), reads the true
 * head, and proceeds — so a bounded retry is correct, not a band-aid.
 */
const RETRYABLE_APPEND_CODES = new Set(['P2034', 'P2002']);

/** Max attempts for a single append before giving up (bounded). */
const MAX_APPEND_ATTEMPTS = 30;

/**
 * The genesis link: the `prevHash` of the FIRST row in any chain. 64 zero hex
 * chars. MUST match `prisma/audit-backfill.ts` byte-for-byte.
 */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/** Default chain identifier when an event does not name one. */
const GLOBAL_CHAIN = 'global';

/**
 * A single auditable event. `userId` / `target` / `meta` are optional and
 * coerced to `null` (never `undefined`) before hashing so canonicalization is
 * stable. `chainKey` defaults to `'global'`.
 */
export interface AuditEvent {
  action: AuditAction;
  userId?: string | null;
  target?: string | null;
  meta?: Record<string, unknown>;
  chainKey?: string;
}

/**
 * Result of {@link AuditService.verifyChain}. A clean chain reports the head;
 * a broken chain reports the FIRST diverging seq and why.
 */
export type VerifyResult =
  | {
      ok: true;
      chainKey: string;
      checked: number;
      head: { seq: bigint; hash: string } | null;
    }
  | {
      ok: false;
      chainKey: string;
      firstBrokenSeq: bigint;
      reason: 'GAP' | 'PREV_MISMATCH' | 'HASH_MISMATCH';
    };

/**
 * Tamper-evident audit log (TDA-008, spec §4/§8).
 *
 * {@link append} is the ONLY sanctioned writer of `audit_logs`. Each row is
 * linked into a SHA-256 hash chain per `chainKey`: `hash = sha256(prevHash +
 * canonicalize(payload))`, where the payload field-set / ordering / coercion is
 * an exact mirror of `prisma/audit-backfill.ts` — that cross-task invariant is
 * what lets {@link verifyChain} recompute and validate historical rows.
 *
 * AuditLog is intentionally NOT a tenant model, so reads/writes here pass
 * through {@link PrismaService}'s tenant extension UNSCOPED — a single global
 * chain, not a per-user one. {@link append} is STRICT: it throws on failure and
 * never swallows errors.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append one event to its chain and return the assigned `{ seq, hash }`.
   *
   * Runs in a SERIALIZABLE transaction guarded by a per-chain Postgres advisory
   * lock so concurrent appends to the same chain serialise (no seq gaps, no
   * duplicate seq). On a lost race the `@@unique([chainKey, seq])` constraint
   * raises `P2002` — left to throw (strict).
   */
  async append(event: AuditEvent): Promise<{ seq: bigint; hash: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
      try {
        return await this.appendOnce(event);
      } catch (err) {
        if (attempt < MAX_APPEND_ATTEMPTS && isRetryableAppendError(err)) {
          lastError = err;
          // Tiny jittered backoff to avoid a thundering herd re-colliding.
          await sleep(2 + Math.floor(Math.random() * 8));
          continue;
        }
        throw err;
      }
    }
    // Unreachable in practice (the loop returns or throws), but keeps the
    // function total and surfaces the real cause if attempts are exhausted.
    throw lastError;
  }

  /** One transactional attempt to append. May throw a retryable conflict. */
  private async appendOnce(
    event: AuditEvent,
  ): Promise<{ seq: bigint; hash: string }> {
    const chainKey = event.chainKey ?? GLOBAL_CHAIN;
    const action = event.action;
    const userId = event.userId ?? null;
    const target = event.target ?? null;
    const meta = event.meta ?? null;

    return this.prisma.$transaction(
      async (tx) => {
        // Serialise appends to THIS chain. The lock is released automatically at
        // transaction end. chainKey is a BOUND parameter, never interpolated.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chainKey}, 0))`;

        const head = await tx.auditLog.findFirst({
          where: { chainKey },
          orderBy: { seq: 'desc' },
          select: { seq: true, hash: true },
        });

        const seq = (head?.seq ?? 0n) + 1n;
        const prevHash = head?.hash ?? GENESIS_PREV_HASH;
        const createdAt = new Date();

        // CROSS-TASK INVARIANT — must equal prisma/audit-backfill.ts and
        // verifyChain() below byte-for-byte: field-set { chainKey, seq, action,
        // userId, target, meta, createdAt }, `?? null` coercion, seq as bigint,
        // createdAt the Date that is also stored.
        const payload = canonicalize({
          chainKey,
          seq,
          action,
          userId,
          target,
          meta,
          createdAt,
        });
        const hash = sha256(prevHash + payload);

        await tx.auditLog.create({
          data: {
            chainKey,
            seq,
            userId,
            target,
            action,
            // null meta → SQL NULL (DbNull); an object → stored as-is. Either
            // way it reads back as `null`/the object, matching the hashed value.
            meta: meta === null ? Prisma.DbNull : (meta as Prisma.InputJsonValue),
            prevHash,
            hash,
            createdAt,
          },
        });

        return { seq, hash };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  /**
   * Verify a chain end-to-end. Pure, read-only: recomputes each row's hash from
   * stored columns and checks contiguity + prevHash linkage. Returns the FIRST
   * divergence (checks ordered GAP → PREV_MISMATCH → HASH_MISMATCH per row).
   */
  async verifyChain(chainKey: string = GLOBAL_CHAIN): Promise<VerifyResult> {
    const rows = await this.prisma.auditLog.findMany({
      where: { chainKey },
      orderBy: { seq: 'asc' },
      select: {
        chainKey: true,
        seq: true,
        action: true,
        userId: true,
        target: true,
        meta: true,
        createdAt: true,
        prevHash: true,
        hash: true,
      },
    });

    if (rows.length === 0) {
      return { ok: true, chainKey, checked: 0, head: null };
    }

    let prevHash = GENESIS_PREV_HASH;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const expectedSeq = BigInt(i + 1);

      // 1. Contiguity: seq must be 1,2,3… with no gaps.
      if (row.seq !== expectedSeq) {
        return { ok: false, chainKey, firstBrokenSeq: expectedSeq, reason: 'GAP' };
      }

      // 2. prevHash linkage to the previous row (genesis for the first).
      if (row.prevHash !== prevHash) {
        return {
          ok: false,
          chainKey,
          firstBrokenSeq: row.seq,
          reason: 'PREV_MISMATCH',
        };
      }

      // 3. Recompute the hash over the stored, canonicalized payload.
      const payload = canonicalize({
        chainKey: row.chainKey,
        seq: row.seq,
        action: row.action,
        userId: row.userId ?? null,
        target: row.target ?? null,
        meta: row.meta ?? null,
        createdAt: row.createdAt,
      });
      const expectedHash = sha256(row.prevHash + payload);
      if (expectedHash !== row.hash) {
        return {
          ok: false,
          chainKey,
          firstBrokenSeq: row.seq,
          reason: 'HASH_MISMATCH',
        };
      }

      prevHash = row.hash;
    }

    const last = rows[rows.length - 1];
    return {
      ok: true,
      chainKey,
      checked: rows.length,
      head: { seq: last.seq, hash: last.hash },
    };
  }
}

/** True if `err` is a concurrency conflict an append retry can resolve. */
function isRetryableAppendError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    RETRYABLE_APPEND_CODES.has(err.code)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
