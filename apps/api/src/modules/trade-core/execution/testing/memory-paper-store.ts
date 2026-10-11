import { Prisma } from '@prisma/client';
import type { Vehicle } from '../../strategies/blocks/block-types';
import type { CoreOrder, OrderState } from '../execution.types';
import { isOpenState } from '../order-state';
import type { PaperSettings } from '../paper-settings';
import type { CoreCashLedgerRepository, LedgerEntry, NewLedgerRow } from '../repositories/core-cash-ledger.repository';
import type { CoreFillRepository, FillRow, NewFillRow } from '../repositories/core-fill.repository';
import type { CoreOrderRepository, NewOrderRow, OrderUpdate } from '../repositories/core-order.repository';
import type { CorePaperTx } from '../repositories/core-paper-tx';
import type { CorePaperDefaultsService } from '../services/core-paper-defaults.service';
import { paperSettings } from './paper-fixtures';

const copy = (o: CoreOrder): CoreOrder => ({ ...o, instrument: { ...o.instrument } });

/** The error Postgres-backed Prisma raises for a duplicate core_orders.idempotencyKey. */
export function idempotencyKeyViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`idempotencyKey`)', {
    code: 'P2002',
    clientVersion: 'memory',
    meta: { modelName: 'CoreOrder', target: ['idempotencyKey'] },
  });
}

/**
 * One in-memory database behind the three repositories and the paper transaction, for
 * service tests. There is no rollback: the services write their guarded order update
 * before any fill or ledger row, so a lost race writes nothing here either.
 */
export class MemoryPaperStore {
  orders: CoreOrder[] = [];
  fills: FillRow[] = [];
  ledger: LedgerEntry[] = [];
  /** The userId of every transaction, in order. */
  txUsers: string[] = [];
  private seq = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  readonly tx = {
    run: async <T>(userId: string, fn: (db: never) => Promise<T>): Promise<T> => {
      this.txUsers.push(userId);
      return fn(undefined as never);
    },
  } as unknown as CorePaperTx;

  readonly orderRepo = {
    findByKey: async (key: string) => {
      const o = this.orders.find((x) => x.idempotencyKey === key);
      return o ? copy(o) : null;
    },
    findForUser: async (userId: string, id: string) => {
      const o = this.orders.find((x) => x.id === id && x.userId === userId);
      return o ? copy(o) : null;
    },
    listForUser: async (userId: string) => this.orders.filter((o) => o.userId === userId).map(copy),
    listOpenForUser: async (userId: string) => this.orders.filter((o) => o.userId === userId && isOpenState(o.state)).map(copy),
    listForPosition: async (userId: string, vehicle: Vehicle, token: string) =>
      this.orders.filter((o) => o.userId === userId && o.vehicle === vehicle && o.instrument.token === token).map(copy),
    listOpenAll: async () => this.orders.filter((o) => isOpenState(o.state)).map(copy),
    listMtfHolders: async () => {
      const seen = new Map<string, { userId: string; token: string }>();
      for (const o of this.orders) {
        if (o.vehicle === 'MTF' && o.filledQty > 0) seen.set(`${o.userId}|${o.instrument.token}`, { userId: o.userId, token: o.instrument.token });
      }
      return [...seen.values()];
    },
    create: async (data: NewOrderRow) => {
      if (this.orders.some((o) => o.idempotencyKey === data.idempotencyKey)) throw idempotencyKeyViolation();
      const o: CoreOrder = {
        id: this.nextId('ord'),
        userId: data.userId,
        idempotencyKey: data.idempotencyKey,
        vehicle: data.vehicle,
        instrument: { exchange: data.exchange, token: data.token, symbol: data.symbol, lotSize: data.lotSize, underlying: data.underlying },
        side: data.side,
        qty: data.qty,
        filledQty: 0,
        avgFillPrice: null,
        type: data.type,
        limitPrice: data.limitPrice,
        triggerPrice: data.triggerPrice,
        refPrice: data.refPrice,
        purpose: data.purpose,
        strategyVersionId: data.strategyVersionId,
        state: data.state,
        rejectReason: data.rejectReason,
        submittedAt: data.submittedAt,
        triggeredAt: null,
        updatedAt: this.clock(),
      };
      this.orders.push(o);
      return copy(o);
    },
    update: async (userId: string, id: string, expect: { state: OrderState; filledQty: number }, data: OrderUpdate) => {
      const o = this.orders.find((x) => x.id === id && x.userId === userId && x.state === expect.state && x.filledQty === expect.filledQty);
      if (!o) return null;
      if (data.state !== undefined) o.state = data.state;
      if (data.filledQty !== undefined) o.filledQty = data.filledQty;
      if (data.avgFillPrice !== undefined) o.avgFillPrice = data.avgFillPrice === null ? null : data.avgFillPrice.toNumber();
      if (data.rejectReason !== undefined) o.rejectReason = data.rejectReason;
      if (data.qty !== undefined) o.qty = data.qty;
      if (data.limitPrice !== undefined) o.limitPrice = data.limitPrice;
      if (data.triggerPrice !== undefined) o.triggerPrice = data.triggerPrice;
      if (data.triggeredAt !== undefined) o.triggeredAt = data.triggeredAt;
      o.updatedAt = this.clock();
      return copy(o);
    },
  } as unknown as CoreOrderRepository;

  readonly fillRepo = {
    listForOrders: async (userId: string, orderIds: readonly string[]) => this.fills.filter((f) => f.userId === userId && orderIds.includes(f.orderId)),
    listForUser: async (userId: string) => this.fills.filter((f) => f.userId === userId),
    create: async (data: NewFillRow) => {
      const f: FillRow = { ...data, id: this.nextId('fil'), createdAt: this.clock() };
      this.fills.push(f);
      return f;
    },
  } as unknown as CoreFillRepository;

  private entry(r: NewLedgerRow): LedgerEntry {
    return {
      id: this.nextId('led'),
      userId: r.userId,
      type: r.type,
      amount: r.amount,
      orderId: r.orderId ?? null,
      fillId: r.fillId ?? null,
      token: r.token ?? null,
      interestDate: r.interestDate ?? null,
      note: r.note,
      createdAt: this.clock(),
    };
  }

  readonly ledgerRepo = {
    listForUser: async (userId: string) => this.ledger.filter((r) => r.userId === userId),
    append: async (rows: readonly NewLedgerRow[]) => {
      for (const r of rows) this.ledger.push(this.entry(r));
    },
    appendInterest: async (rows: readonly NewLedgerRow[]) => {
      let n = 0;
      for (const r of rows) {
        const dup = this.ledger.some((x) => x.userId === r.userId && x.token === (r.token ?? null) && x.interestDate === (r.interestDate ?? null));
        if (dup) continue;
        this.ledger.push(this.entry(r));
        n += 1;
      }
      return n;
    },
    lastInterestDate: async (userId: string, token: string) => {
      const days = this.ledger.filter((r) => r.userId === userId && r.token === token && r.type === 'MTF_INTEREST').map((r) => r.interestDate as string);
      return days.length ? days.sort()[days.length - 1] : null;
    },
  } as unknown as CoreCashLedgerRepository;
}

/** A settings service answering the fixture settings, or "incomplete" for null. */
export function fakeDefaults(settings: PaperSettings | null = paperSettings()): CorePaperDefaultsService {
  return {
    settings: async () => (settings ? { ok: true as const, settings } : { ok: false as const, missing: ['startingCapital@ALL'] }),
  } as unknown as CorePaperDefaultsService;
}
