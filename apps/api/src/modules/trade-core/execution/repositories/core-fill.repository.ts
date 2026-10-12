import { Injectable } from '@nestjs/common';
import type { CoreFill as CoreFillRow, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { FillCharges } from '../execution.types';
import type { PaperDb } from './core-order.repository';

export interface FillRow {
  id: string;
  orderId: string;
  userId: string;
  price: Prisma.Decimal;
  qty: number;
  charges: FillCharges;
  chargesTotal: Prisma.Decimal;
  priceAt: Date;
  createdAt: Date;
}

export interface NewFillRow {
  orderId: string;
  userId: string;
  price: Prisma.Decimal;
  qty: number;
  charges: FillCharges;
  chargesTotal: Prisma.Decimal;
  priceAt: Date;
}

const toFill = (r: CoreFillRow): FillRow => ({
  id: r.id,
  orderId: r.orderId,
  userId: r.userId,
  price: r.price,
  qty: r.qty,
  charges: r.charges as unknown as FillCharges,
  chargesTotal: r.chargesTotal,
  priceAt: r.priceAt,
  createdAt: r.createdAt,
});

const OLDEST_FIRST = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/** core_fills: append-only (spec §4.5). No update or delete method; a trigger refuses UPDATE. */
@Injectable()
export class CoreFillRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForOrders(userId: string, orderIds: readonly string[], db: PaperDb = this.prisma): Promise<FillRow[]> {
    if (orderIds.length === 0) return [];
    return (await db.coreFill.findMany({ where: { userId, orderId: { in: [...orderIds] } }, orderBy: OLDEST_FIRST })).map(toFill);
  }

  async listForUser(userId: string, db: PaperDb = this.prisma): Promise<FillRow[]> {
    return (await db.coreFill.findMany({ where: { userId }, orderBy: OLDEST_FIRST })).map(toFill);
  }

  async create(data: NewFillRow, db: PaperDb): Promise<FillRow> {
    return toFill(await db.coreFill.create({ data: { ...data, charges: data.charges as unknown as Prisma.InputJsonValue } }));
  }
}
