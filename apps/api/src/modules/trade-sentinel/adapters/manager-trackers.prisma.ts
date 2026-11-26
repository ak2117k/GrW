import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ManagerTrackerLookup } from '../ports/manager-trackers.port';

/**
 * MANAGER_TRACKERS over signal_orders.source = 'manager' (the desk manager's live orders). Database only, so the
 * sentinel never imports the desk-manager module. Throws on a database error; the cycle treats that as "none"
 * (the flat rule keeps applying — fail safe).
 */
@Injectable()
export class PrismaManagerTrackers implements ManagerTrackerLookup {
  constructor(private readonly prisma: PrismaService) {}

  async managerTrackerIds(trackerIds: readonly string[]): Promise<ReadonlySet<string>> {
    const ids = trackerIds.filter((t) => typeof t === 'string' && t !== '' && !t.startsWith('paper:'));
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.signalOrder.findMany({
      where: { source: 'manager', trackerId: { in: ids } },
      select: { trackerId: true },
    });
    return new Set(rows.map((r) => r.trackerId).filter((t): t is string => typeof t === 'string'));
  }
}
