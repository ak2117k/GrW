import { Injectable } from '@nestjs/common';
import type { CoreOrder as CoreOrderRow, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { Vehicle } from '../../strategies/blocks/block-types';
import type { CoreOrder, OrderPurpose, OrderSide, OrderState, OrderType } from '../execution.types';
import { OPEN_STATES } from '../order-state';

/** A transaction client, or PrismaService itself for reads outside one. */
export type PaperDb = Prisma.TransactionClient;

export interface NewOrderRow {
  userId: string;
  idempotencyKey: string;
  vehicle: Vehicle;
  exchange: string;
  token: string;
  symbol: string;
  lotSize: number;
  underlying: string | null;
  side: OrderSide;
  qty: number;
  type: OrderType;
  limitPrice: number | null;
  triggerPrice: number | null;
  refPrice: number;
  purpose: OrderPurpose;
  strategyVersionId: string | null;
  state: OrderState;
  rejectReason: string | null;
  submittedAt: Date;
  positionId?: string | null;
}

export interface OrderUpdate {
  state?: OrderState;
  filledQty?: number;
  /** Callers round to 4 dp before writing (ledger-math's avgPrice is unrounded). */
  avgFillPrice?: Prisma.Decimal | null;
  rejectReason?: string | null;
  qty?: number;
  limitPrice?: number | null;
  triggerPrice?: number | null;
  /**
   * Ruling P10: set when a fill decision reports `triggered: true` (also on a NONE
   * decision), in the same transaction as any fill. A stop never un-triggers.
   */
  triggeredAt?: Date;
}

const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : d.toNumber());

export function toCoreOrder(r: CoreOrderRow): CoreOrder {
  return {
    id: r.id,
    userId: r.userId,
    idempotencyKey: r.idempotencyKey,
    vehicle: r.vehicle as Vehicle,
    instrument: { exchange: r.exchange, token: r.token, symbol: r.symbol, lotSize: r.lotSize, underlying: r.underlying },
    side: r.side as OrderSide,
    qty: r.qty,
    filledQty: r.filledQty,
    avgFillPrice: num(r.avgFillPrice),
    type: r.type as OrderType,
    limitPrice: num(r.limitPrice),
    triggerPrice: num(r.triggerPrice),
    refPrice: r.refPrice.toNumber(),
    purpose: r.purpose as OrderPurpose,
    strategyVersionId: r.strategyVersionId,
    positionId: r.positionId,
    state: r.state as OrderState,
    rejectReason: r.rejectReason,
    submittedAt: r.submittedAt,
    triggeredAt: r.triggeredAt,
    updatedAt: r.updatedAt,
  };
}

const OLDEST_FIRST = [{ submittedAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * core_orders. Every per-user query names the userId; the tenant extension adds the
 * same filter for non-admin requests. findByKey reads the globally unique key alone so
 * the service can refuse a key that belongs to another user (it never returns that
 * order; ruling P2). listOpenAll and listMtfHolders are the two system scans (plan
 * Global Constraints). Updates are guarded by the state and filledQty the caller read.
 */
@Injectable()
export class CoreOrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByKey(idempotencyKey: string, db: PaperDb = this.prisma): Promise<CoreOrder | null> {
    const r = await db.coreOrder.findUnique({ where: { idempotencyKey } });
    return r ? toCoreOrder(r) : null;
  }

  async findForUser(userId: string, id: string, db: PaperDb = this.prisma): Promise<CoreOrder | null> {
    const r = await db.coreOrder.findFirst({ where: { id, userId } });
    return r ? toCoreOrder(r) : null;
  }

  async listForUser(userId: string, db: PaperDb = this.prisma): Promise<CoreOrder[]> {
    return (await db.coreOrder.findMany({ where: { userId }, orderBy: OLDEST_FIRST })).map(toCoreOrder);
  }

  async listOpenForUser(userId: string, db: PaperDb = this.prisma): Promise<CoreOrder[]> {
    return (await db.coreOrder.findMany({ where: { userId, state: { in: [...OPEN_STATES] } }, orderBy: OLDEST_FIRST })).map(toCoreOrder);
  }

  async listForPosition(userId: string, vehicle: Vehicle, token: string, db: PaperDb = this.prisma): Promise<CoreOrder[]> {
    return (await db.coreOrder.findMany({ where: { userId, vehicle, token }, orderBy: OLDEST_FIRST })).map(toCoreOrder);
  }

  /** SP2 M4: one core position's orders. */
  async listForPositionId(userId: string, positionId: string, db: PaperDb = this.prisma): Promise<CoreOrder[]> {
    return (await db.coreOrder.findMany({ where: { userId, positionId }, orderBy: OLDEST_FIRST })).map(toCoreOrder);
  }

  /** System scan (matcher boot): every user's open orders. */
  async listOpenAll(): Promise<CoreOrder[]> {
    return (await this.prisma.coreOrder.findMany({ where: { state: { in: [...OPEN_STATES] } }, orderBy: OLDEST_FIRST })).map(toCoreOrder);
  }

  /** System scan (interest cron): every (user, token) that has ever bought MTF. */
  listMtfHolders(): Promise<Array<{ userId: string; token: string }>> {
    return this.prisma.coreOrder.findMany({
      where: { vehicle: 'MTF', filledQty: { gt: 0 } },
      select: { userId: true, token: true },
      distinct: ['userId', 'token'],
    });
  }

  async create(data: NewOrderRow, db: PaperDb): Promise<CoreOrder> {
    return toCoreOrder(await db.coreOrder.create({ data }));
  }

  /** Applies `data` only if the row is still in `expect`; null when another writer got there first. */
  async update(userId: string, id: string, expect: { state: OrderState; filledQty: number }, data: OrderUpdate, db: PaperDb): Promise<CoreOrder | null> {
    const { count } = await db.coreOrder.updateMany({ where: { id, userId, state: expect.state, filledQty: expect.filledQty }, data });
    if (count !== 1) return null;
    return this.findForUser(userId, id, db);
  }
}
