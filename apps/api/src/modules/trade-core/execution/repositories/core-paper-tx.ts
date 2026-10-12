import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { PaperDb } from './core-order.repository';

/**
 * One transaction under the user's paper lock (spec §5: order state, fill and ledger
 * rows commit together). The lock serialises a user's placements, fills and closes, so
 * a free-cash check and the margin it blocks can never interleave with another write.
 */
@Injectable()
export class CorePaperTx {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(userId: string, fn: (db: PaperDb) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core_paper:${userId}`}, 0))`;
      return fn(tx);
    });
  }
}
