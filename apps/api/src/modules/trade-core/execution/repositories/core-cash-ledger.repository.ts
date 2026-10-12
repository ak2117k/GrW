import { Injectable } from '@nestjs/common';
import type { CoreCashLedger as CoreCashLedgerRow, Prisma } from '@prisma/client';
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
