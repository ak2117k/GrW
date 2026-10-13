import { Injectable } from '@nestjs/common';
import { Prisma, type CoreCashLedger as CoreCashLedgerRow } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { LedgerType } from '../execution.types';
import type { PaperDb } from './core-order.repository';

export interface LedgerEntry {
  id: string;
  userId: string;
  type: LedgerType;
  amount: Prisma.Decimal;
  orderId: string | null;
  fillId: string | null;
  token: string | null;
  /** YYYY-MM-DD, MTF_INTEREST only. */
  interestDate: string | null;
  note: string;
  createdAt: Date;
}

export interface NewLedgerRow {
  userId: string;
  type: LedgerType;
  amount: Prisma.Decimal;
  orderId?: string | null;
  fillId?: string | null;
  token?: string | null;
  interestDate?: string | null;
  note: string;
}

const dayOf = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

const toEntry = (r: CoreCashLedgerRow): LedgerEntry => ({
  id: r.id,
  userId: r.userId,
  type: r.type as LedgerType,
  amount: r.amount,
  orderId: r.orderId,
  fillId: r.fillId,
  token: r.token,
  interestDate: dayOf(r.interestDate),
  note: r.note,
  createdAt: r.createdAt,
});

const toData = (r: NewLedgerRow) => ({
  userId: r.userId,
  type: r.type,
  amount: r.amount,
  orderId: r.orderId ?? null,
  fillId: r.fillId ?? null,
  token: r.token ?? null,
  interestDate: r.interestDate ? new Date(`${r.interestDate}T00:00:00.000Z`) : null,
  note: r.note,
});

/**
 * core_cash_ledger: append-only (spec §4.4). No update or delete method; a trigger
 * refuses UPDATE. appendInterest relies on the unique (userId, token, interestDate)
 * index to make the nightly posting idempotent.
 */
@Injectable()
export class CoreCashLedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string, db: PaperDb = this.prisma): Promise<LedgerEntry[]> {
    return (await db.coreCashLedger.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(toEntry);
  }

  /** M5 (J19): rows created at or after `since`. */
  async listForUserSince(userId: string, since: Date, db: PaperDb = this.prisma): Promise<LedgerEntry[]> {
    return (await db.coreCashLedger.findMany({ where: { userId, createdAt: { gte: since } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(toEntry);
  }

  async listForOrders(userId: string, orderIds: readonly string[], db: PaperDb = this.prisma): Promise<LedgerEntry[]> {
    if (orderIds.length === 0) return [];
    return (await db.coreCashLedger.findMany({ where: { userId, orderId: { in: [...orderIds] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(toEntry);
  }

  /** MTF_INTEREST rows on `token` for interest days in [fromDay, toDay]. */
  async listInterest(userId: string, token: string, fromDay: string, toDay: string, db: PaperDb = this.prisma): Promise<LedgerEntry[]> {
    const rows = await db.coreCashLedger.findMany({
      where: { userId, token, type: 'MTF_INTEREST', interestDate: { gte: new Date(`${fromDay}T00:00:00.000Z`), lte: new Date(`${toDay}T00:00:00.000Z`) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toEntry);
  }

  async interestTokensOn(userId: string, day: string): Promise<Set<string>> {
    const rows = await this.prisma.coreCashLedger.findMany({ where: { userId, type: 'MTF_INTEREST', interestDate: new Date(`${day}T00:00:00.000Z`) }, select: { token: true } });
    return new Set(rows.map((r) => r.token).filter((t): t is string => t !== null));
  }

  /** M5 (J19): Σ amount per type over the user's whole ledger, in SQL. */
  async sumsByType(userId: string): Promise<Array<{ type: LedgerType; amount: Prisma.Decimal }>> {
    const rows = await this.prisma.$queryRaw<Array<{ type: string; amount: Prisma.Decimal | string }>>`
      SELECT "type" AS "type", SUM("amount") AS "amount" FROM "core_cash_ledger" WHERE "userId" = ${userId} GROUP BY "type"`;
    return rows.map((r) => ({ type: r.type as LedgerType, amount: new Prisma.Decimal(r.amount) }));
  }

  /** M5 (J19): margin still held (−Σ MARGIN_BLOCK + MARGIN_RELEASE) per vehicle of the orders, in SQL. */
  async heldMarginByVehicle(userId: string): Promise<Map<string, Prisma.Decimal>> {
    const rows = await this.prisma.$queryRaw<Array<{ vehicle: string; held: Prisma.Decimal | string }>>`
      SELECT o."vehicle" AS "vehicle", -SUM(l."amount") AS "held"
      FROM "core_cash_ledger" l JOIN "core_orders" o ON o."id" = l."orderId"
      WHERE l."userId" = ${userId} AND l."type" IN ('MARGIN_BLOCK', 'MARGIN_RELEASE')
      GROUP BY o."vehicle"`;
    return new Map(rows.map((r) => [r.vehicle, new Prisma.Decimal(r.held)]));
  }

  async append(rows: readonly NewLedgerRow[], db: PaperDb): Promise<void> {
    if (rows.length === 0) return;
    await db.coreCashLedger.createMany({ data: rows.map(toData) });
  }

  /** Inserts the interest days not yet posted; returns how many were new. */
  async appendInterest(rows: readonly NewLedgerRow[], db: PaperDb): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await db.coreCashLedger.createMany({ data: rows.map(toData), skipDuplicates: true });
    return count;
  }

  async lastInterestDate(userId: string, token: string, db: PaperDb = this.prisma): Promise<string | null> {
    const r = await db.coreCashLedger.findFirst({
      where: { userId, token, type: 'MTF_INTEREST' },
      orderBy: { interestDate: 'desc' },
      select: { interestDate: true },
    });
    return dayOf(r?.interestDate ?? null);
  }
}
