import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

export interface PaperDefaultRow {
  key: string;
  scope: string;
  numValue: Prisma.Decimal;
  note: string;
  updatedBy: string | null;
  updatedAt: Date;
}

/** core_paper_defaults: global settings data, owner-edited (not append-only; its CHECKs pin the shapes). */
@Injectable()
export class CorePaperDefaultsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(): Promise<PaperDefaultRow[]> {
    return this.prisma.corePaperDefault.findMany({ orderBy: [{ key: 'asc' }, { scope: 'asc' }] });
  }

  upsert(key: string, scope: string, numValue: Prisma.Decimal, note: string, updatedBy: string, now: Date): Promise<PaperDefaultRow> {
    return this.prisma.corePaperDefault.upsert({
      where: { key_scope: { key, scope } },
      create: { key, scope, numValue, note, updatedBy, updatedAt: now },
      update: { numValue, note, updatedBy, updatedAt: now },
    });
  }
}
