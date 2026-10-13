import { Injectable } from '@nestjs/common';
import { Prisma, type CorePosition as CorePositionRow } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import type { OrderSide } from '../../execution/execution.types';
import type { Direction } from '../../risk-wall/risk-wall.types';
import type { Vehicle } from '../../strategies/blocks/block-types';
import { ACTIVE_STATUSES, type CorePosition, type CorePositionStatus, type ExitPlan, type ExitReason, type NewPositionRow, type PositionPatch } from '../lifecycle.types';

export class ActivePositionExistsError extends Error {
  constructor(readonly existingId: string) {
    super(`an active core position (${existingId}) already exists on this instrument for this user`);
    this.name = 'ActivePositionExistsError';
  }
}

const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : d.toNumber());
const PRICE_FIELDS = ['entryAvgPrice', 'initialStopPrice', 'stopPrice', 'targetPrice', 'partialPrice', 'highWater', 'lowWater'] as const;

export function toCorePosition(r: CorePositionRow): CorePosition {
  const vehicle = r.vehicle as Vehicle;
  return {
    id: r.id,
    userId: r.userId,
    intentId: r.intentId,
    strategyId: r.strategyId,
    strategyVersionId: r.strategyVersionId,
    vehicle,
    instrument: { exchange: r.exchange, token: r.token, symbol: r.symbol, lotSize: r.lotSize, underlying: vehicle === 'OPTIONS_BUY' ? r.underlying : null },
    underlying: r.underlying,
    side: r.side as OrderSide,
    direction: r.direction as Direction,
    status: r.status as CorePositionStatus,
    requestedQty: r.requestedQty,
    entryFilledQty: r.entryFilledQty,
    exitFilledQty: r.exitFilledQty,
    openQty: r.entryFilledQty - r.exitFilledQty,
    entryAvgPrice: num(r.entryAvgPrice),
    plan: r.plan as unknown as ExitPlan,
    initialStopPrice: num(r.initialStopPrice),
    stopPrice: num(r.stopPrice),
    targetPrice: num(r.targetPrice),
    partialPrice: num(r.partialPrice),
    partialQty: r.partialQty,
    trailActive: r.trailActive,
    partialDone: r.partialDone,
    highWater: num(r.highWater),
    lowWater: num(r.lowWater),
    exitSeq: r.exitSeq,
    exitReason: r.exitReason as ExitReason | null,
    blindSince: r.blindSince,
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: r.version,
  };
}

function patchData(p: PositionPatch): Prisma.CorePositionUpdateManyMutationInput {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    data[k] = (PRICE_FIELDS as readonly string[]).includes(k) && v !== null ? new Prisma.Decimal(v as number) : v;
  }
  return data as Prisma.CorePositionUpdateManyMutationInput;
}

/**
 * core_positions (spec §7.1). Every per-user query names the userId; listActive and
 * listActiveUserIds are the two system scans (boot recovery, the daily-loss monitor); they run
 * outside any tenant context, since CorePosition is tenant-scoped and a scan started inside a
 * user's request (a kill switch before the first sweep) must still see every user's rows.
 * Updates are guarded by `version` (ruling L11); creation holds the user's position lock so
 * two intents can never open two active positions on one instrument.
 */
@Injectable()
export class CorePositionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Run fn with tenant scoping lifted (the CoreKillSwitchReader pattern): only when a CLS store
   * is active, since runWithoutTenant throws outside one (crons, timers), where Prisma is
   * already unscoped. For system work only; per-user queries name their userId.
   */
  withoutTenant<T>(fn: () => T): T {
    return this.cls.isActive() ? this.tenant.runWithoutTenant(fn) : fn();
  }

  async createIfNoActive(row: NewPositionRow): Promise<CorePosition> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core_position:${row.userId}`}, 0))`;
      const active = await tx.corePosition.findFirst({
        where: { userId: row.userId, exchange: row.instrument.exchange.toUpperCase(), token: row.instrument.token, status: { in: [...ACTIVE_STATUSES] } },
        select: { id: true },
      });
      if (active) throw new ActivePositionExistsError(active.id);
      const created = await tx.corePosition.create({
        data: {
          userId: row.userId,
          intentId: row.intentId,
          strategyId: row.strategyId,
          strategyVersionId: row.strategyVersionId,
          vehicle: row.vehicle,
          exchange: row.instrument.exchange.toUpperCase(),
          token: row.instrument.token,
          symbol: row.instrument.symbol,
          lotSize: row.instrument.lotSize,
          underlying: row.underlying,
          side: row.side,
          direction: row.direction,
          status: 'PENDING_ENTRY',
          requestedQty: row.requestedQty,
          plan: row.plan as unknown as Prisma.InputJsonValue,
        },
      });
      return toCorePosition(created);
    });
  }

  /** The intent id is globally unique; the caller refuses another user's row. */
  async findByIntent(intentId: string): Promise<CorePosition | null> {
    const r = await this.prisma.corePosition.findUnique({ where: { intentId } });
    return r ? toCorePosition(r) : null;
  }

  async findForUser(userId: string, id: string): Promise<CorePosition | null> {
    const r = await this.prisma.corePosition.findFirst({ where: { id, userId } });
    return r ? toCorePosition(r) : null;
  }

  /** System scan (boot recovery): every user's active positions, oldest first. */
  async listActive(): Promise<CorePosition[]> {
    const rows = await this.withoutTenant(() =>
      this.prisma.corePosition.findMany({ where: { status: { in: [...ACTIVE_STATUSES] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    );
    return rows.map(toCorePosition);
  }

  /** System scan (daily-loss monitor). */
  async listActiveUserIds(): Promise<string[]> {
    const rows = await this.withoutTenant(() =>
      this.prisma.corePosition.findMany({ where: { status: { in: [...ACTIVE_STATUSES] } }, select: { userId: true }, distinct: ['userId'], orderBy: { userId: 'asc' } }),
    );
    return rows.map((r) => r.userId);
  }

  /** The user's active positions plus those closed at or after `since` (all when null), oldest first. */
  async listForUser(userId: string, since: Date | null): Promise<CorePosition[]> {
    const rows = await this.prisma.corePosition.findMany({
      where: since ? { userId, OR: [{ status: { in: [...ACTIVE_STATUSES] } }, { closedAt: { gte: since } }] } : { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toCorePosition);
  }

  /** M5 cooldown (J5): when this strategy last opened (first fill) a position on the token. */
  async lastOpenedAt(userId: string, strategyId: string, token: string): Promise<Date | null> {
    const r = await this.prisma.corePosition.findFirst({
      where: { userId, strategyId, token, openedAt: { not: null } },
      orderBy: { openedAt: 'desc' },
      select: { openedAt: true },
    });
    return r?.openedAt ?? null;
  }

  /** M5 last-loss filter (J5): this strategy's CLOSED positions on the token closed since `since`, newest close first. */
  async listClosedSince(userId: string, strategyId: string, token: string, since: Date): Promise<CorePosition[]> {
    const rows = await this.prisma.corePosition.findMany({
      where: { userId, strategyId, token, status: 'CLOSED', closedAt: { gte: since } },
      orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toCorePosition);
  }

  /** M5 reconciliation system scan: users with an active position, or one created or closed since `since`. */
  async listUserIdsSince(since: Date): Promise<string[]> {
    const rows = await this.withoutTenant(() =>
      this.prisma.corePosition.findMany({
        where: { OR: [{ status: { in: [...ACTIVE_STATUSES] } }, { createdAt: { gte: since } }, { closedAt: { gte: since } }] },
        select: { userId: true },
        distinct: ['userId'],
        orderBy: { userId: 'asc' },
      }),
    );
    return rows.map((r) => r.userId);
  }

  /** Applies `patch` only at `expectVersion`; null when another writer got there first. */
  async update(userId: string, id: string, expectVersion: number, patch: PositionPatch): Promise<CorePosition | null> {
    const { count } = await this.prisma.corePosition.updateMany({
      where: { id, userId, version: expectVersion },
      data: { ...patchData(patch), version: { increment: 1 } },
    });
    if (count !== 1) return null;
    return this.findForUser(userId, id);
  }
}
