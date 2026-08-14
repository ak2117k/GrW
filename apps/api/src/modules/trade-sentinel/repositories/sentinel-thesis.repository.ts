import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SentinelThesis } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { StoredThesis } from '../services/context-packet.service';

/** The agent formed this thesis by reading the position. */
export const THESIS_SOURCE_INFERRED = 'INFERRED';
/** The user stated this thesis. Outranks inference until they change it again. */
export const THESIS_SOURCE_USER = 'USER';

/** Prisma's unique-constraint code — a lost create race, not a fault. */
const UNIQUE_VIOLATION = 'P2002';

export interface ThesisDraft {
  userId: string;
  direction: string;
  reason: string;
  levelPrice: number | null;
  targetPrice: number | null;
  invalidation: number | null;
}

/**
 * What a user is allowed to change about their own thesis.
 *
 * `userId` is excluded BY TYPE and stripped again at runtime — a patch able to
 * set its own tenant could re-attribute the row to another account, which is the
 * same defect as an unscoped `where` approached from the other side. `source` is
 * absent for the same reason: a correction that could set itself back to
 * INFERRED would silently re-open itself to being overwritten.
 */
export type UserThesisPatch = Omit<Partial<ThesisDraft>, 'userId'>;

/** The only keys a correction may write. Everything else is discarded, not trusted. */
const PATCHABLE = ['direction', 'reason', 'levelPrice', 'targetPrice', 'invalidation'] as const;

const DIRECTIONS = ['LONG', 'SHORT'];

/**
 * `UserThesisPatch` is a COMPILE-TIME claim and the correction endpoint receives
 * runtime JSON, so the type guarantees nothing about what actually arrives. This
 * rebuilds the update from a whitelist rather than spreading the caller's object:
 * a spread would carry `userId`, `id` or `createdAt` straight into Prisma.
 *
 * The value checks are the same ones inference is held to — `direction: 'FLAT'`
 * or `levelPrice: '1450'` reaching a Float column reads back fine and breaks
 * arithmetic several modules downstream, and a thesis is the thing every later
 * "has it turned?" judgement is measured against.
 */
function sanitisePatch(patch: UserThesisPatch): Record<string, string | number | null> {
  const raw = patch as Record<string, unknown>;
  const data: Record<string, string | number | null> = {};

  for (const key of PATCHABLE) {
    const value = raw[key];
    if (value === undefined) continue;

    if (key === 'direction') {
      if (typeof value !== 'string' || !DIRECTIONS.includes(value)) {
        throw new BadRequestException(
          `thesis direction must be one of ${DIRECTIONS.join(', ')}`,
        );
      }
      data[key] = value;
      continue;
    }

    if (key === 'reason') {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new BadRequestException('thesis reason must be a non-empty sentence');
      }
      data[key] = value.trim();
      continue;
    }

    if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) {
      throw new BadRequestException(`thesis ${key} must be a number or null`);
    }
    data[key] = value as number | null;
  }

  // An empty patch would stamp `source: 'USER'` on whatever is stored and say
  // nothing — freezing an inferred (or stated-unknown) thesis as permanent and
  // beyond the reach of re-inference, which is the opposite of a correction.
  if (Object.keys(data).length === 0) {
    throw new BadRequestException('a thesis correction must change at least one field');
  }
  return data;
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

  /**
   * A user restating what they were actually trading.
   *
   * TENANT-SCOPED, and that is the whole point of the signature. This is the
   * module's one user-facing write, and `where: { trackerId }` alone — with
   * `trackerId` a guessable cuid — is an IDOR: any account could rewrite another
   * account's thesis, and since the thesis is what every later "has it turned?"
   * judgement is measured against, that is an attacker steering someone else's
   * exit decisions.
   *
   * `updateMany` rather than `update` deliberately: `update` needs a unique
   * `where`, and `userId` is not part of one, so scoping it would rely on
   * Prisma's extended-unique filter and would raise P2025 on a cross-tenant
   * attempt — a 500 that also confirms the row exists. `updateMany` simply
   * matches nothing, and a miss is reported as an indistinguishable 404 whether
   * the row belongs to someone else or does not exist at all.
   */
  async overrideByUser(
    trackerId: string,
    userId: string,
    patch: UserThesisPatch,
  ): Promise<StoredThesis> {
    const data = sanitisePatch(patch);

    const { count } = await this.prisma.sentinelThesis.updateMany({
      where: { trackerId, userId },
      // `source` is applied LAST and unconditionally, over sanitised data that
      // cannot contain it: a correction must not be able to re-open itself.
      data: { ...data, source: THESIS_SOURCE_USER },
    });

    if (count === 0) {
      throw new NotFoundException(
        `no thesis on record for tracker ${trackerId} — nothing to correct`,
      );
    }

    // Safe to read by trackerId alone: ownership was just proven by the write.
    const row = await this.find(trackerId);
    if (!row) {
      throw new NotFoundException(
        `no thesis on record for tracker ${trackerId} — nothing to correct`,
      );
    }
    return row;
  }
}
