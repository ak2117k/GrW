import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import type { CoreFunds, CoreOrder, CoreOrderRequest, OrderSide } from './execution.types';
import { validateOrder } from './fill-model';
import { applyPositionFill, balances, FLAT, istDate, money, ZERO, type PositionState } from './ledger-math';
import { marginFor, marginRefPrice } from './margin';
import { isOpenState, nextState, transition } from './order-state';
import type { PaperSettings, PaperSettingsResult } from './paper-settings';
import { CoreCashLedgerRepository, type LedgerEntry, type NewLedgerRow } from './repositories/core-cash-ledger.repository';
import { CoreFillRepository, type FillRow } from './repositories/core-fill.repository';
import { CoreOrderRepository, type PaperDb } from './repositories/core-order.repository';
import { CorePaperTx } from './repositories/core-paper-tx';
import { CorePaperDefaultsService } from './services/core-paper-defaults.service';

type Dec = Prisma.Decimal;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const MARGIN_TYPES: ReadonlySet<string> = new Set(['MARGIN_BLOCK', 'MARGIN_RELEASE']);
const KEY_TAKEN = 'this idempotency key is already used by another order';
/** Ruling P13: the stored reason when the settings read throws; the error itself is only logged. */
export const SETTINGS_UNREADABLE = 'paper settings are unreadable';

export interface PlaceContext {
  /** CORE_SESSION_CLOCK.isOpen(exchange, now) at placement. */
  sessionOpen: boolean;
  /** The user's core kill switch (an unreadable switch is passed as true). */
  killSwitchActive: boolean;
}

export interface PlaceResult {
  order: CoreOrder;
  /** False when the idempotency key already had an order (returned as is). */
  created: boolean;
  /** The settings the order was checked with; null when it was not checked. */
  settings: PaperSettings | null;
}

/** One (vehicle, token) of one user, before the write being prepared. */
export interface PositionContext {
  orders: CoreOrder[];
  fills: FillRow[];
  state: PositionState;
  pendingExitQty: number;
  /** Margin the position holds: its margin rows that carry a fillId (plan ruling 4). */
  blocked: Dec;
}

/** −Σ of the margin rows `pick` selects: what they hold blocked. */
export function heldMargin(rows: readonly LedgerEntry[], pick: (r: LedgerEntry) => boolean): Dec {
  return rows.filter((r) => MARGIN_TYPES.has(r.type) && pick(r)).reduce((a, r) => a.minus(r.amount), ZERO);
}

/** What an order's unfilled qty holds: its margin rows with no fillId. */
export function pendingMargin(rows: readonly LedgerEntry[], orderId: string): Dec {
  return heldMargin(rows, (r) => r.orderId === orderId && r.fillId === null);
}

export const positionKey = (o: Pick<CoreOrder, 'vehicle' | 'instrument'>): string => `${o.vehicle}:${o.instrument.token}`;

/**
 * Ruling P12: a P2002 unique violation on core_orders.idempotencyKey. Prisma names the
 * fields in meta.target (an array of field names; a constraint-name string on some
 * engines). A P2002 on anything else is not an idempotency conflict.
 */
function isIdempotencyKeyViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target: unknown = err.meta?.target;
  if (Array.isArray(target)) return target.includes('idempotencyKey');
  return typeof target === 'string' && target.includes('idempotencyKey');
}

/**
 * Every write and read of core orders, fills and the cash ledger (spec §4.4–§4.5, §5).
 * Each write is one transaction under the user's paper lock, so the order row, its fill
 * and its ledger rows commit together. Margin is kept in two kinds of rows (plan ruling
 * 4): rows without a fillId hold an order's unfilled qty, rows with a fillId hold the
 * position. Every query names the user.
 */
@Injectable()
export class PaperLedgerService {
  private readonly logger = new Logger(PaperLedgerService.name);

  constructor(
    private readonly tx: CorePaperTx,
    private readonly orders: CoreOrderRepository,
    private readonly fills: CoreFillRepository,
    private readonly ledger: CoreCashLedgerRepository,
    private readonly defaults: CorePaperDefaultsService,
  ) {}

  /**
   * Idempotent on the key. A business rejection is persisted as REJECTED with its reason;
   * an accepted ENTRY blocks margin for its qty at its reference price. The user's first
   * order also deposits the starting capital.
   *
   * Rulings P3/P12: a same-user retry returns the existing order; a key that belongs to
   * another user is 409 Conflict and never returns that order. In request context the
   * tenant extension hides another user's row from findByKey, so that collision surfaces
   * as P2002 at create; the transaction rolls back and it becomes 409 too.
   */
  async place(req: CoreOrderRequest, ctx: PlaceContext, now: Date = new Date()): Promise<PlaceResult> {
    const prior = await this.orders.findByKey(req.idempotencyKey);
    if (prior) return { order: this.sameUser(prior, req.userId), created: false, settings: null };
    // null: the settings could not be read. The error is logged, never persisted (ruling P13).
    let loaded: PaperSettingsResult | null;
    try {
      loaded = await this.defaults.settings(now.getTime());
    } catch (err) {
      this.logger.error(`paper settings unreadable; order ${req.idempotencyKey} is rejected: ${errorText(err)}`);
      loaded = null;
    }
    try {
      return await this.tx.run(req.userId, async (db) => {
        const again = await this.orders.findByKey(req.idempotencyKey, db);
        if (again) return { order: this.sameUser(again, req.userId), created: false, settings: null };
        const settings = loaded?.ok ? loaded.settings : null;
        const rows = await this.ledger.listForUser(req.userId, db);
        const deposit: NewLedgerRow[] =
          rows.length === 0 && settings
            ? [{ userId: req.userId, type: 'DEPOSIT', amount: money(settings.startingCapital), note: 'starting paper capital (core_paper_defaults startingCapital)' }]
            : [];

        let reason: string | null = null;
        let block = ZERO;
        if (!settings) reason = loaded === null ? SETTINGS_UNREADABLE : `paper settings are incomplete: ${loaded.ok ? '' : loaded.missing.join(', ')}`;
        else if (!ctx.sessionOpen) reason = `${req.instrument.exchange.toUpperCase()} is not in session`;
        else if (req.purpose === 'ENTRY' && ctx.killSwitchActive) reason = 'the kill switch is on: no new entries';
        else {
          const pos = await this.positionContext(req.userId, req.vehicle, req.instrument.token, rows, db);
          reason = validateOrder(req, { settings, position: { netQty: pos.state.netQty }, pendingExitQty: pos.pendingExitQty });
          if (!reason && req.purpose === 'ENTRY') {
            block = marginFor(req.vehicle, marginRefPrice(req).mul(req.qty), settings);
            const free = balances([...rows, ...deposit.map((d) => ({ type: d.type, amount: d.amount }))]).freeCash;
            if (free.lt(block)) reason = `insufficient free cash: the order blocks ₹${block.toFixed(2)}, ₹${free.toFixed(2)} is free`;
          }
        }

        const order = await this.orders.create(
          {
            userId: req.userId,
            idempotencyKey: req.idempotencyKey,
            vehicle: req.vehicle,
            exchange: req.instrument.exchange.toUpperCase(),
            token: req.instrument.token,
            symbol: req.instrument.symbol,
            lotSize: req.instrument.lotSize,
            underlying: req.instrument.underlying ? req.instrument.underlying.trim().toUpperCase() : null,
            side: req.side,
            qty: req.qty,
            type: req.type,
            limitPrice: req.limitPrice,
            triggerPrice: req.triggerPrice,
            refPrice: req.refPrice,
            purpose: req.purpose,
            strategyVersionId: req.strategyVersionId,
            state: transition('NEW', reason ? 'REJECT' : 'ACCEPT'),
            rejectReason: reason,
            submittedAt: now,
          },
          db,
        );
        const entries = [...deposit];
        if (!reason && block.gt(0)) {
          entries.push({
            userId: req.userId,
            type: 'MARGIN_BLOCK',
            amount: ZERO.minus(block),
            orderId: order.id,
            token: order.instrument.token,
            note: `margin for ${req.side} ${req.qty} ${req.instrument.symbol} at ₹${marginRefPrice(req).toFixed(2)}`,
          });
        }
        await this.ledger.append(entries, db);
        return { order, created: true, settings };
      });
    } catch (err) {
      if (!isIdempotencyKeyViolation(err)) throw err;
      // The transaction rolled back. A same-user race finds its order; a key held by
      // another user is invisible here in request context (tenant scope) or not ours.
      const raced = await this.orders.findByKey(req.idempotencyKey);
      if (!raced) throw new ConflictException(KEY_TAKEN);
      return { order: this.sameUser(raced, req.userId), created: false, settings: null };
    }
  }

  /**
   * CANCEL or REJECT an open order and release its pending margin exactly (spec §4.4).
   * An order already closed is returned unchanged; a PARTIAL order is never rejected
   * for want of a price (it had one), so REJECT on PARTIAL also returns it unchanged.
   */
  async close(userId: string, orderId: string, event: 'CANCEL' | 'REJECT', reason: string): Promise<CoreOrder> {
    return this.tx.run(userId, async (db) => {
      const order = await this.orders.findForUser(userId, orderId, db);
      if (!order) throw new NotFoundException(`core order ${orderId} not found`);
      const state = nextState(order.state, event);
      if (!state) return order;
      const updated = await this.orders.update(
        userId,
        orderId,
        { state: order.state, filledQty: order.filledQty },
        { state, rejectReason: event === 'REJECT' ? reason : null },
        db,
      );
      if (!updated) throw new ConflictException(`core order ${orderId} changed while closing; retry`);
      if (order.purpose === 'ENTRY') {
        const release = pendingMargin(await this.ledger.listForUser(userId, db), orderId);
        if (release.gt(0)) {
          await this.ledger.append(
            [
              {
                userId,
                type: 'MARGIN_RELEASE',
                amount: release,
                orderId,
                token: order.instrument.token,
                note: `${event === 'CANCEL' ? 'cancelled' : 'rejected'}: margin for the ${order.qty - order.filledQty} unfilled units (${reason})`,
              },
            ],
            db,
          );
        }
      }
      return updated;
    });
  }

  async getOrder(userId: string, orderId: string): Promise<CoreOrder> {
    const o = await this.orders.findForUser(userId, orderId);
    if (!o) throw new NotFoundException(`core order ${orderId} not found`);
    return o;
  }

  findOrder(userId: string, orderId: string): Promise<CoreOrder | null> {
    return this.orders.findForUser(userId, orderId);
  }

  /** System scan for the matcher's boot reload. */
  openOrders(): Promise<CoreOrder[]> {
    return this.orders.listOpenAll();
  }

  openOrdersForUser(userId: string): Promise<CoreOrder[]> {
    return this.orders.listOpenForUser(userId);
  }

  async funds(userId: string): Promise<CoreFunds> {
    const [rows, orders] = await Promise.all([this.ledger.listForUser(userId), this.orders.listForUser(userId)]);
    const b = balances(rows);
    const vehicleOf = new Map(orders.map((o) => [o.id, o.vehicle]));
    const deployedByVehicle = Object.fromEntries(
      VEHICLES.map((v) => [v, heldMargin(rows, (r) => r.orderId !== null && vehicleOf.get(r.orderId) === v).toFixed(2)]),
    ) as Record<Vehicle, string>;
    return {
      userId,
      deposited: b.deposited.toFixed(2),
      realisedPnl: b.realisedPnl.toFixed(2),
      charges: b.charges.toFixed(2),
      mtfInterest: b.mtfInterest.toFixed(2),
      cash: b.cash.toFixed(2),
      blockedMargin: b.blockedMargin.toFixed(2),
      freeCash: b.freeCash.toFixed(2),
      deployedByVehicle,
    };
  }

  /** Today's (IST) net realised P&L (realised − charges − interest) and accepted entries, for the Risk Wall. */
  async dayStats(userId: string, now: Date): Promise<{ netPnlToday: Dec; entriesToday: number }> {
    const day = istDate(now);
    const [rows, orders] = await Promise.all([this.ledger.listForUser(userId), this.orders.listForUser(userId)]);
    const netPnlToday = rows
      .filter((r) => (r.type === 'REALISED_PNL' || r.type === 'CHARGES' || r.type === 'MTF_INTEREST') && istDate(r.createdAt) === day)
      .reduce((a, r) => a.plus(r.amount), ZERO);
    const entriesToday = orders.filter((o) => o.purpose === 'ENTRY' && o.state !== 'REJECTED' && istDate(o.submittedAt) === day).length;
    return { netPnlToday, entriesToday };
  }

  /** The position on (vehicle, token) from its fills, and the margin it holds, from `rows`. */
  async positionContext(userId: string, vehicle: Vehicle, token: string, rows: readonly LedgerEntry[], db?: PaperDb): Promise<PositionContext> {
    const orders = await this.orders.listForPosition(userId, vehicle, token, db);
    const sideOf = new Map<string, OrderSide>(orders.map((o) => [o.id, o.side]));
    const fills = await this.fills.listForOrders(userId, orders.map((o) => o.id), db);
    const state = fills.reduce(
      (s, f) => applyPositionFill(s, { side: sideOf.get(f.orderId) as OrderSide, qty: f.qty, price: f.price, at: f.priceAt }).state,
      FLAT,
    );
    const pendingExitQty = orders.filter((o) => o.purpose === 'EXIT' && isOpenState(o.state)).reduce((n, o) => n + o.qty - o.filledQty, 0);
    const ids = new Set(orders.map((o) => o.id));
    const blocked = heldMargin(rows, (r) => r.orderId !== null && ids.has(r.orderId) && r.fillId !== null);
    return { orders, fills, state, pendingExitQty, blocked };
  }

  private sameUser(o: CoreOrder, userId: string): CoreOrder {
    if (o.userId !== userId) throw new ConflictException(KEY_TAKEN);
    return o;
  }
}
