import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { EventImpact, EventScope, MarketEventInput, StoredMarketEvent } from '../types';

@Injectable()
export class MarketEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Replace ONE source's rows inside [from, to]: upsert what it now says, delete what it no longer says. */
  async syncSource(source: string, from: Date, to: Date, rows: readonly MarketEventInput[], now: Date): Promise<{ upserted: number; removed: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const keep = new Set(rows.map((r) => `${r.kind}|${r.key}|${r.startsAt.toISOString()}`));
        const existing = await tx.marketEvent.findMany({ where: { source, startsAt: { gte: from, lte: to } }, select: { id: true, kind: true, key: true, startsAt: true } });
        const gone = existing.filter((e) => !keep.has(`${e.kind}|${e.key}|${e.startsAt.toISOString()}`)).map((e) => e.id);
        if (gone.length > 0) await tx.marketEvent.deleteMany({ where: { id: { in: gone } } });
        for (const r of rows) {
          const data = { scope: r.scope, title: r.title, allDay: r.allDay, impact: r.impact, source: r.source, sourceRef: r.sourceRef, fetchedAt: now };
          await tx.marketEvent.upsert({
            where: { kind_key_startsAt: { kind: r.kind, key: r.key, startsAt: r.startsAt } },
            create: { ...data, kind: r.kind, key: r.key, startsAt: r.startsAt },
            update: data,
          });
        }
        return { upserted: rows.length, removed: gone.length };
      },
      { timeout: 30_000 },
    );
  }

  async listFrom(from: Date): Promise<StoredMarketEvent[]> {
    const rows = await this.prisma.marketEvent.findMany({ where: { startsAt: { gte: from } }, orderBy: { startsAt: 'asc' } });
    return rows.map((r) => ({ ...r, scope: r.scope as EventScope, impact: r.impact as EventImpact }));
  }
}
