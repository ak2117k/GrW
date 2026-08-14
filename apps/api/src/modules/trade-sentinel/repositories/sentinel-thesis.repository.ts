import { Injectable } from '@nestjs/common';
import { Prisma, type SentinelThesis } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { StoredThesis } from '../services/context-packet.service';

/** The agent formed this thesis by reading the position. */
export const THESIS_SOURCE_INFERRED = 'INFERRED';
/** The user stated this thesis. Outranks inference until they change it again. */
export const THESIS_SOURCE_USER = 'USER';

/** Prisma's unique-constraint code — a lost create race, not a fault. */
const UNIQUE_VIOLATION = 'P2002';
/** Prisma's "record to update not found" code. */
const RECORD_NOT_FOUND = 'P2025';

export interface ThesisDraft {
  userId: string;
  direction: string;
  reason: string;
  levelPrice: number | null;
  targetPrice: number | null;
  invalidation: number | null;
}

/**
 * Columns to packet shape. `userId`, `id` and the timestamps deliberately do NOT
 * cross: the thesis is embedded verbatim in the context packet the agent reads,
 * and a tenant id in an LLM prompt is data leakage with no upside.
 */
function toStored(row: SentinelThesis): StoredThesis {
  return {
    direction: row.direction,
    reason: row.reason,
    levelPrice: row.levelPrice,
    targetPrice: row.targetPrice,
    invalidation: row.invalidation,
    source: row.source,
  };
}

function isPrismaCode(err: unknown, code: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

/**
 * One thesis per tracked trade, and the record of who decided it.
 *
 * "Reversed" is only meaningful against a stated expectation, so this row is
 * what makes the sentinel's central question answerable at all. The invariant
 * that matters is the precedence: inference must never overwrite a correction.
 */
@Injectable()
export class SentinelThesisRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(trackerId: string): Promise<StoredThesis | null> {
    const row = await this.prisma.sentinelThesis.findUnique({ where: { trackerId } });
    return row ? toStored(row) : null;
  }

  /**
   * Write an inferred thesis — unless the user has already stated one.
   *
   * The USER guard is a WRITE PREDICATE, not a read-then-write. A read-first
   * check would leave a window in which a correction submitted mid-inference is
   * silently reverted by an inference that started before it; the correction
   * would look accepted in the UI and be gone on the next tick. `updateMany`
   * with `source: { not: 'USER' }` makes the guard atomic with the write, and
   * the only remaining window — a correction that lands between the update and
   * the create — is closed by yielding to whoever won the unique constraint.
   */
  async upsertInferred(trackerId: string, draft: ThesisDraft): Promise<StoredThesis> {
    const { count } = await this.prisma.sentinelThesis.updateMany({
      where: { trackerId, source: { not: THESIS_SOURCE_USER } },
      data: { ...draft, source: THESIS_SOURCE_INFERRED },
    });

    if (count > 0) {
      // The row IS the draft now; re-reading it would only add a round trip.
      return {
        direction: draft.direction,
        reason: draft.reason,
        levelPrice: draft.levelPrice,
        targetPrice: draft.targetPrice,
        invalidation: draft.invalidation,
        source: THESIS_SOURCE_INFERRED,
      };
    }

    // Nothing matched: either there is no row yet, or the one there is USER's.
    const existing = await this.find(trackerId);
    if (existing) return existing;

    try {
      const row = await this.prisma.sentinelThesis.create({
        data: { trackerId, ...draft, source: THESIS_SOURCE_INFERRED },
      });
      return toStored(row);
    } catch (err) {
      if (!isPrismaCode(err, UNIQUE_VIOLATION)) throw err;
      // Someone else created the row between the update and this create. Their
      // write stands — ours is the stale one, and if theirs is a correction,
      // overwriting it is precisely what must not happen.
      const raced = await this.find(trackerId);
      if (raced) return raced;
      throw err;
    }
  }

  async overrideByUser(
    trackerId: string,
    patch: Partial<ThesisDraft>,
  ): Promise<StoredThesis> {
    try {
      const row = await this.prisma.sentinelThesis.update({
        where: { trackerId },
        // `source` is applied LAST and unconditionally: a patch that could set
        // its own source would let a correction be re-opened to inference.
        data: { ...patch, source: THESIS_SOURCE_USER },
      });
      return toStored(row);
    } catch (err) {
      if (isPrismaCode(err, RECORD_NOT_FOUND)) {
        throw new Error(
          `no thesis on record for tracker ${trackerId} yet — nothing to correct`,
        );
      }
      throw err;
    }
  }
}
