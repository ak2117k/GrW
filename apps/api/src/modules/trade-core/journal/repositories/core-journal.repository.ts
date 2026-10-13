import { Injectable } from '@nestjs/common';
import { Prisma, type CoreJournal as CoreJournalDb } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import { istDate } from '../../execution/ledger-math';
import type { JournalEntry, JournalRow, JournalType } from '../journal.types';
import { inSystemScope } from './system-scope';

const dayDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const OLDEST_FIRST = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const finiteOrNull = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);

export function toJournalData(e: JournalEntry) {
  const price = finiteOrNull(e.priceUsed);
  const age = finiteOrNull(e.priceAgeMs);
  return {
    userId: e.userId,
    type: e.type,
    positionId: e.positionId ?? null,
    strategyId: e.strategyId ?? null,
    strategyVersionId: e.strategyVersionId ?? null,
    intentId: e.intentId ?? null,
    symbol: e.symbol ?? null,
    payload: e.payload as Prisma.InputJsonValue,
    priceUsed: price === null ? null : new Prisma.Decimal(price),
    priceAgeMs: age === null ? null : Math.max(0, Math.round(age)),
    dedupeKey: e.dedupeKey ?? null,
    istDay: dayDate(istDate(e.at)),
    createdAt: e.at,
  };
}

export function toJournalRow(r: CoreJournalDb): JournalRow {
  return {
    id: r.id,
    userId: r.userId,
    type: r.type as JournalType,
    positionId: r.positionId,
    strategyId: r.strategyId,
    strategyVersionId: r.strategyVersionId,
    intentId: r.intentId,
    symbol: r.symbol,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    priceUsed: r.priceUsed === null ? null : r.priceUsed.toNumber(),
    priceAgeMs: r.priceAgeMs,
    dedupeKey: r.dedupeKey,
    istDay: r.istDay.toISOString().slice(0, 10),
    createdAt: r.createdAt,
  };
}

/**
 * core_journal (spec §8.1): append-only. No update or delete method exists (a trigger refuses
 * UPDATE too). Every per-user read names the userId; listTypeOnDay is the one system scan (the
 * follow-up job) and lifts tenant scoping like CorePositionRepository.listActive.
 */
@Injectable()
export class CoreJournalRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly cls: ClsService,
  ) {}

  private withoutTenant<T>(fn: () => T): T {
    return this.cls.isActive() ? this.tenant.runWithoutTenant(fn) : fn();
  }

  /**
   * In order; a row whose dedupeKey already exists is skipped. Returns how many were new. Written
   * outside any tenant scope, so every row keeps its own userId whoever's request drains it.
   */
  async append(entries: readonly JournalEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const data = entries.map(toJournalData);
    const { count } = await inSystemScope(this.cls, () => this.prisma.coreJournal.createMany({ data, skipDuplicates: true }));
    return count;
  }

  async listForPosition(userId: string, positionId: string): Promise<JournalRow[]> {
    return (await this.prisma.coreJournal.findMany({ where: { userId, positionId }, orderBy: OLDEST_FIRST })).map(toJournalRow);
  }

  async listForDay(userId: string, day: string, types?: readonly JournalType[]): Promise<JournalRow[]> {
    const where = { userId, istDay: dayDate(day), ...(types ? { type: { in: [...types] } } : {}) };
    return (await this.prisma.coreJournal.findMany({ where, orderBy: OLDEST_FIRST })).map(toJournalRow);
  }

  async findForUser(userId: string, id: string): Promise<JournalRow | null> {
    const r = await this.prisma.coreJournal.findFirst({ where: { userId, id } });
    return r ? toJournalRow(r) : null;
  }

  async hasType(userId: string, day: string, type: JournalType): Promise<boolean> {
    return (await this.prisma.coreJournal.findFirst({ where: { userId, istDay: dayDate(day), type }, select: { id: true } })) !== null;
  }

  /** Every RECON_MISMATCH of the user without its RECON_ACK (dedupeKey `ack:<mismatchId>`). */
  async unackedMismatches(userId: string): Promise<JournalRow[]> {
    const mismatches = await this.prisma.coreJournal.findMany({ where: { userId, type: 'RECON_MISMATCH' }, orderBy: OLDEST_FIRST });
    if (mismatches.length === 0) return [];
    const acks = await this.prisma.coreJournal.findMany({ where: { userId, type: 'RECON_ACK' }, select: { dedupeKey: true } });
    const acked = new Set(acks.map((a) => a.dedupeKey));
    return mismatches.filter((m) => !acked.has(`ack:${m.id}`)).map(toJournalRow);
  }

  /** System scan (follow-ups): every user's rows of one type on one IST day, oldest first, at most `take`. */
  async listTypeOnDay(type: JournalType, day: string, take: number): Promise<JournalRow[]> {
    const rows = await this.withoutTenant(() =>
      this.prisma.coreJournal.findMany({ where: { type, istDay: dayDate(day) }, orderBy: OLDEST_FIRST, take }),
    );
    return rows.map(toJournalRow);
  }
}
