import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import type { Vehicle } from '../../strategies/blocks/block-types';
import type { CoreOrder, LedgerType, OrderState } from '../execution.types';
import { isOpenState } from '../order-state';
import type { PaperSettings } from '../paper-settings';
import type { CoreCashLedgerRepository, LedgerEntry, NewLedgerRow } from '../repositories/core-cash-ledger.repository';
import type { CoreFillRepository, FillRow, NewFillRow } from '../repositories/core-fill.repository';
import type { CoreOrderRepository, NewOrderRow, OrderUpdate, PaperDb } from '../repositories/core-order.repository';
import type { CorePaperTx } from '../repositories/core-paper-tx';
import type { CorePaperDefaultsService } from '../services/core-paper-defaults.service';
import { paperSettings } from './paper-fixtures';

const copy = (o: CoreOrder): CoreOrder => ({ ...o, instrument: { ...o.instrument } });
const copyFill = (f: FillRow): FillRow => ({ ...f, charges: { ...f.charges } });
const copyEntry = (r: LedgerEntry): LedgerEntry => ({ ...r });

/** The error Postgres-backed Prisma raises for a duplicate core_orders.idempotencyKey. */
export function idempotencyKeyViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`idempotencyKey`)', {
    code: 'P2002',
    clientVersion: 'memory',
    meta: { modelName: 'CoreOrder', target: ['idempotencyKey'] },
  });
}

/**
 * Ruling P15: the migration's core_cash_ledger_type_check (migration.sql 116-125), so a
 * row Postgres would refuse is refused here too. A batch is checked whole before any row
 * is stored, as one INSERT would be.
 */
export function checkLedgerRow(r: NewLedgerRow): void {
  const a = r.amount;
  const has = (v: string | null | undefined) => v !== undefined && v !== null;
  const ok: Record<string, boolean> = {
    DEPOSIT: a.gt(0),
    MARGIN_BLOCK: a.lt(0) && has(r.orderId),
    MARGIN_RELEASE: a.gt(0) && has(r.orderId),
    CHARGES: a.lt(0) && has(r.fillId),
    REALISED_PNL: has(r.fillId),
    MTF_INTEREST: a.lte(0) && has(r.token),
  };
  if (ok[r.type] !== true) {
    throw new Error(
      `memory store: core_cash_ledger_type_check violated by ${r.type} ${a.toFixed(2)} (orderId ${r.orderId ?? 'null'}, fillId ${r.fillId ?? 'null'}, token ${r.token ?? 'null'})`,
    );
  }
}

/**
 * One in-memory database behind the three repositories and the paper transaction, for
 * service tests (ruling P13):
 * - `tx.run` snapshots orders, fills and ledger and restores them if its callback
 *   throws, as Postgres would roll back. (Runs are not isolated from each other: a
 *   concurrent run's writes are also undone by a restore. Tests that throw inside a run
 *   should not overlap it with another run.)
 * - Inside a run the repositories receive the sentinel `db`; a write without it, a read
 *   inside a run without it, or the sentinel used outside a run throws. Reads outside a
 *   run (top-level reads and system scans) take no db.
 * - Every read returns copies, so mutating a returned row never changes the store.
 * - Ledger appends enforce the migration's per-type sign and link CHECK (ruling P15).
 */
export class MemoryPaperStore {
  orders: CoreOrder[] = [];
  fills: FillRow[] = [];
  ledger: LedgerEntry[] = [];
  /** The userId of every transaction, in order. */
  txUsers: string[] = [];
  /** The transaction client the store hands to a run's callback. */
  readonly db = Object.freeze({ memoryPaperTx: true }) as unknown as PaperDb;
  private readonly inRun = new AsyncLocalStorage<true>();
  private seq = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  /** A write must run inside a transaction, on its client. */
  private write(op: string, db: unknown): void {
    if (!this.inRun.getStore() || db !== this.db) throw new Error(`memory store: ${op} must run inside tx.run with its db`);
  }

  /** A read inside a run must use the run's client; outside a run it must not have one. */
  private read(op: string, db: unknown): void {
    if (this.inRun.getStore()) {
      if (db !== this.db) throw new Error(`memory store: ${op} inside tx.run must be passed its db`);
    } else if (db !== undefined) {
      throw new Error(`memory store: ${op} outside tx.run was passed a db`);
    }
  }

  readonly tx = {
    run: async <T>(userId: string, fn: (db: PaperDb) => Promise<T>): Promise<T> => {
      this.txUsers.push(userId);
      const orders = this.orders.map(copy);
      const fills = this.fills.map(copyFill);
      const ledger = this.ledger.map(copyEntry);
      try {
        return await this.inRun.run(true, () => fn(this.db));
      } catch (err) {
        this.orders.splice(0, this.orders.length, ...orders);
        this.fills.splice(0, this.fills.length, ...fills);
        this.ledger.splice(0, this.ledger.length, ...ledger);
        throw err;
      }
    },
  } as unknown as CorePaperTx;

  readonly orderRepo = {
    findByKey: async (key: string, db?: PaperDb) => {
      this.read('findByKey', db);
      const o = this.orders.find((x) => x.idempotencyKey === key);
      return o ? copy(o) : null;
    },
    findForUser: async (userId: string, id: string, db?: PaperDb) => {
      this.read('findForUser', db);
      const o = this.orders.find((x) => x.id === id && x.userId === userId);
      return o ? copy(o) : null;
    },
    listForUser: async (userId: string, db?: PaperDb) => {
      this.read('listForUser', db);
      return this.orders.filter((o) => o.userId === userId).map(copy);
    },
    listForUserSince: async (userId: string, since: Date, db?: PaperDb) => {
      this.read('listForUserSince', db);
      return this.orders.filter((o) => o.userId === userId && o.submittedAt.getTime() >= since.getTime()).map(copy);
    },
    listByIds: async (userId: string, ids: readonly string[], db?: PaperDb) => {
      this.read('listByIds', db);
      return this.orders.filter((o) => o.userId === userId && ids.includes(o.id)).map(copy);
    },
    listOpenForUser: async (userId: string, db?: PaperDb) => {
      this.read('listOpenForUser', db);
      return this.orders.filter((o) => o.userId === userId && isOpenState(o.state)).map(copy);
    },
    listForPosition: async (userId: string, vehicle: Vehicle, token: string, db?: PaperDb) => {
      this.read('listForPosition', db);
      return this.orders.filter((o) => o.userId === userId && o.vehicle === vehicle && o.instrument.token === token).map(copy);
    },
    listForPositionId: async (userId: string, positionId: string, db?: PaperDb) => {
      this.read('listForPositionId', db);
      return this.orders.filter((o) => o.userId === userId && o.positionId === positionId).map(copy);
    },
    listOpenAll: async () => this.orders.filter((o) => isOpenState(o.state)).map(copy),
    listMtfHolders: async () => {
      const seen = new Map<string, { userId: string; token: string }>();
      for (const o of this.orders) {
        if (o.vehicle === 'MTF' && o.filledQty > 0) seen.set(`${o.userId}|${o.instrument.token}`, { userId: o.userId, token: o.instrument.token });
      }
      return [...seen.values()];
    },
    create: async (data: NewOrderRow, db: PaperDb) => {
      this.write('order create', db);
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
        positionId: data.positionId ?? null,
        state: data.state,
        rejectReason: data.rejectReason,
        submittedAt: data.submittedAt,
        triggeredAt: null,
        updatedAt: this.clock(),
      };
      this.orders.push(o);
      return copy(o);
    },
    update: async (userId: string, id: string, expect: { state: OrderState; filledQty: number }, data: OrderUpdate, db: PaperDb) => {
      this.write('order update', db);
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
    listForOrders: async (userId: string, orderIds: readonly string[], db?: PaperDb) => {
      this.read('listForOrders', db);
      return this.fills.filter((f) => f.userId === userId && orderIds.includes(f.orderId)).map(copyFill);
    },
    listForUser: async (userId: string, db?: PaperDb) => {
      this.read('fill listForUser', db);
      return this.fills.filter((f) => f.userId === userId).map(copyFill);
    },
    create: async (data: NewFillRow, db: PaperDb) => {
      this.write('fill create', db);
      const f: FillRow = { ...data, charges: { ...data.charges }, id: this.nextId('fil'), createdAt: this.clock() };
      this.fills.push(f);
      return copyFill(f);
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
    listForUser: async (userId: string, db?: PaperDb) => {
      this.read('ledger listForUser', db);
      return this.ledger.filter((r) => r.userId === userId).map(copyEntry);
    },
    listForUserSince: async (userId: string, since: Date, db?: PaperDb) => {
      this.read('ledger listForUserSince', db);
      return this.ledger.filter((r) => r.userId === userId && r.createdAt.getTime() >= since.getTime()).map(copyEntry);
    },
    listForOrders: async (userId: string, orderIds: readonly string[], db?: PaperDb) => {
      this.read('ledger listForOrders', db);
      return this.ledger.filter((r) => r.userId === userId && r.orderId !== null && orderIds.includes(r.orderId)).map(copyEntry);
    },
    listInterest: async (userId: string, token: string, fromDay: string, toDay: string, db?: PaperDb) => {
      this.read('ledger listInterest', db);
      return this.ledger
        .filter((r) => r.userId === userId && r.type === 'MTF_INTEREST' && r.token === token && r.interestDate !== null && r.interestDate >= fromDay && r.interestDate <= toDay)
        .map(copyEntry);
    },
    interestTokensOn: async (userId: string, day: string) =>
      new Set(this.ledger.filter((r) => r.userId === userId && r.type === 'MTF_INTEREST' && r.interestDate === day && r.token !== null).map((r) => r.token as string)),
    sumsByType: async (userId: string) => {
      const sums = new Map<LedgerType, Prisma.Decimal>();
      for (const r of this.ledger.filter((x) => x.userId === userId)) sums.set(r.type, (sums.get(r.type) ?? new Prisma.Decimal(0)).plus(r.amount));
      return [...sums].map(([type, amount]) => ({ type, amount }));
    },
    heldMarginByVehicle: async (userId: string) => {
      const vehicleOf = new Map(this.orders.map((o) => [o.id, o.vehicle]));
      const held = new Map<string, Prisma.Decimal>();
      for (const r of this.ledger.filter((x) => x.userId === userId && (x.type === 'MARGIN_BLOCK' || x.type === 'MARGIN_RELEASE') && x.orderId !== null)) {
        const v = vehicleOf.get(r.orderId as string);
        if (v) held.set(v, (held.get(v) ?? new Prisma.Decimal(0)).minus(r.amount));
      }
      return held;
    },
    append: async (rows: readonly NewLedgerRow[], db: PaperDb) => {
      this.write('ledger append', db);
      rows.forEach(checkLedgerRow);
      for (const r of rows) this.ledger.push(this.entry(r));
    },
    appendInterest: async (rows: readonly NewLedgerRow[], db: PaperDb) => {
      this.write('ledger appendInterest', db);
      rows.forEach(checkLedgerRow);
      let n = 0;
      for (const r of rows) {
        const dup = this.ledger.some((x) => x.userId === r.userId && x.token === (r.token ?? null) && x.interestDate === (r.interestDate ?? null));
        if (dup) continue;
        this.ledger.push(this.entry(r));
        n += 1;
      }
      return n;
    },
    lastInterestDate: async (userId: string, token: string, db?: PaperDb) => {
      this.read('lastInterestDate', db);
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
