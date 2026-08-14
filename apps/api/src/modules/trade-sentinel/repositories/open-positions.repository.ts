import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { OpenPosition, OpenPositionsPort } from '../ports/open-positions.port';

/**
 * The roster's read side, over Prisma directly.
 *
 * This deliberately duplicates the body of `TradeTrackerService.listOpen`
 * rather than calling it. The duplication is four lines and the alternative is
 * making the Angel One adapter reachable from the sentinel cycle — see the note
 * on `OpenPositionsPort`. If the OPEN-trade query ever grows real logic, the
 * right move is to push that logic into a shared query helper that holds no
 * broker, not to re-point this at the service.
 *
 * `select` rather than a bare `findMany`: the sentinel needs four columns, and
 * a narrow projection means a new column on `TradeTracker` cannot silently
 * start flowing into a context packet that is persisted verbatim and replayed.
 */
@Injectable()
export class OpenPositionsRepository implements OpenPositionsPort {
  constructor(private readonly prisma: PrismaService) {}

  async listOpen(userId: string): Promise<OpenPosition[]> {
    return this.prisma.tradeTracker.findMany({
      where: { userId, status: 'OPEN' },
      orderBy: { entryTime: 'asc' },
      select: { id: true, symbol: true, kind: true, entryTime: true },
    });
  }
}
