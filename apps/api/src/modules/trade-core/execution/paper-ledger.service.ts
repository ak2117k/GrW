import { ConflictException, Injectable, Logger, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { chargesForLeg, type Segment } from '../../trade-sentinel/charges';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import type { CoreFunds, CoreOrder, CoreOrderPatch, CoreOrderRequest, CorePositionView, FillCharges, OrderSide } from './execution.types';
import { isWholeLots, maxLotsProblem, priceShapeProblem, validateOrder } from './fill-model';
import { applyPositionFill, balances, dailyMtfInterest, FLAT, istDate, money, mtfInterestDays, ZERO, type PositionState } from './ledger-math';
import { marginFor, marginRefPrice, mtfFunded, proportionalRelease } from './margin';
import { CoreOrderEvents } from './order-events';
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
 * Ruling P14: an ENTRY may not oppose another open (NEW/OPEN/PARTIAL) ENTRY on the same
 * position key (vehicle, token — P14a). `sameKey` are the user's orders on that key. Two
 * opposite entries filling would net against each other as entries, which the position
 * arithmetic cannot book. (Opposing an open position is validateOrder's rule.)
 */
export function opposingEntryProblem(req: Pick<CoreOrderRequest, 'side' | 'vehicle' | 'instrument'>, sameKey: readonly CoreOrder[]): string | null {
  const other = sameKey.find((o) => o.purpose === 'ENTRY' && isOpenState(o.state) && o.side !== req.side);
  if (!other) return null;
  return `an open ${other.side} entry (${other.id}) on ${positionKey(req)} opposes this ${req.side} entry; cancel it first`;
}

/** The charges schedule per vehicle (spec §4.4): MTF is delivery plus the pledge fee. */
export const SEGMENT_BY_VEHICLE: Readonly<Record<Vehicle, Segment>> = {
  CASH_INTRADAY: 'EQ_INTRADAY',
  MTF: 'EQ_DELIVERY',
  OPTIONS_BUY: 'OPT',
};

/**
 * One fill's charges: the fill priced as one executed leg (plan ruling 5), plus the MTF
 * pledge fee on the first buy fill of an MTF order. `total` includes the fee.
 */
export function fillCharges(
  order: Pick<CoreOrder, 'vehicle' | 'side' | 'filledQty'>,
  qty: number,
  price: Dec,
  settings: Pick<PaperSettings, 'mtfPledgeFee'>,
): FillCharges {
  const segment = SEGMENT_BY_VEHICLE[order.vehicle];
  const leg = chargesForLeg({ segment, leg: order.side, price: price.toNumber(), qty });
  const pledgeFee = order.vehicle === 'MTF' && order.side === 'BUY' && order.filledQty === 0 ? settings.mtfPledgeFee.toNumber() : 0;
  return { ...leg, segment, leg: order.side, pledgeFee, total: leg.total + pledgeFee };
}

/** The fields of the order copy a fill or trigger decision was made on (ruling P17). */
export type OrderExpectation = Pick<CoreOrder, 'filledQty' | 'qty' | 'limitPrice' | 'triggerPrice'>;

/**
 * Ruling P17: the locked row still has every field the decision depended on. A modify
 * changes qty, limit or trigger without moving filledQty, so filledQty alone misses it.
 * Prices are numbers or null at this layer (the repository converts Decimals), so ===
 * compares by value and null only equals null.
 */
export function matchesExpectation(row: OrderExpectation, expected: OrderExpectation): boolean {
  return (
    row.filledQty === expected.filledQty &&
    row.qty === expected.qty &&
    row.limitPrice === expected.limitPrice &&
    row.triggerPrice === expected.triggerPrice
  );
}

export interface FillInput {
  qty: number;
  price: Dec;
  /** The market time of the price the fill came from. */
  priceAt: Date;
  /**
   * Ruling P10: the fill decision carried `triggered: true` (the price that first reached an
   * SL_MARKET trigger). triggeredAt is then set to priceAt in the same write as the fill,
   * unless the order already has one.
   */
  triggered?: boolean;
}

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
    @Optional() private readonly events: CoreOrderEvents = new CoreOrderEvents(),
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
      const r = await this.tx.run(req.userId, async (db) => {
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
          if (!reason && req.purpose === 'ENTRY') reason = opposingEntryProblem(req, pos.orders);
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
            positionId: req.positionId ?? null,
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
      if (r.created) this.events.emit(r.order);
      return r;
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
    return this.emitted(this.tx.run(userId, async (db) => {
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
    }));
  }

  /**
   * One fill (spec §4.4), guarded by the order copy the caller decided on (filledQty, qty,
   * limit and trigger, ruling P17): null when the order moved on (another fill, a cancel,
   * a modify), is gone, or the settings are incomplete —
   * nothing is written then (a settings read that throws propagates). A fill that does not
   * fit the order, or an exit fill beyond the open position, is a programming error and
   * throws; the transaction rolls back. The order update comes first (with triggeredAt
   * when the decision was `triggered`, ruling P10), then the fill, then the rows: CHARGES;
   * for an ENTRY the pending margin for this qty is released (no fillId, so close()
   * releases exactly the rest) and margin at the fill price is blocked against the
   * position (with the fillId); for an EXIT the gross realised P&L is booked and the
   * position's margin released in proportion (all of it on the last fill).
   */
  async applyFill(userId: string, orderId: string, expected: OrderExpectation, fill: FillInput, now: Date = new Date()): Promise<CoreOrder | null> {
    const loaded = await this.defaults.settings(now.getTime());
    if (!loaded.ok) return null;
    const settings = loaded.settings;
    return this.emitted(this.tx.run(userId, async (db) => {
      const order = await this.orders.findForUser(userId, orderId, db);
      if (!order || !isOpenState(order.state) || !matchesExpectation(order, expected)) return null;
      const remaining = order.qty - order.filledQty;
      const lot = order.instrument.lotSize;
      if (fill.qty <= 0 || fill.qty > remaining || !isWholeLots(fill.qty, lot) || !fill.price.isFinite() || fill.price.lte(0)) {
        throw new Error(`fill of ${fill.qty} at ${fill.price.toString()} does not fit order ${orderId} (${remaining} left, lot ${lot})`);
      }
      // Fill and average prices are Decimal(14,4): round once, here, and use the stored value throughout.
      const price = fill.price.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      const rows = await this.ledger.listForUser(userId, db);
      const position = await this.positionContext(userId, order.vehicle, order.instrument.token, rows, db);
      const net = position.state.netQty;
      const reduces = (net > 0 && order.side === 'SELL') || (net < 0 && order.side === 'BUY');
      if (order.purpose === 'ENTRY' && reduces) {
        // Ruling P14: an entry fill never reduces or flips a position (the key would become unbookable).
        throw new Error(`entry fill of ${order.side} ${fill.qty} on order ${orderId} opposes the open position of ${net}`);
      }
      if (order.purpose === 'EXIT' && (!reduces || fill.qty > Math.abs(net))) {
        throw new Error(`exit fill of ${order.side} ${fill.qty} on order ${orderId} exceeds the open position of ${net}`);
      }
      const pos = order.purpose === 'EXIT' ? position : null;

      const newFilled = order.filledQty + fill.qty;
      const avg = order.avgFillPrice === null ? price : new Prisma.Decimal(order.avgFillPrice).mul(order.filledQty).plus(price.mul(fill.qty)).div(newFilled);
      const updated = await this.orders.update(
        userId,
        orderId,
        { state: order.state, filledQty: order.filledQty },
        {
          state: transition(order.state, newFilled === order.qty ? 'FILL' : 'PARTIAL_FILL'),
          filledQty: newFilled,
          avgFillPrice: avg.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP),
          ...(fill.triggered && order.triggeredAt === null ? { triggeredAt: fill.priceAt } : {}),
        },
        db,
      );
      if (!updated) return null;

      const charges = fillCharges(order, fill.qty, price, settings);
      const created = await this.fills.create({ orderId, userId, price, qty: fill.qty, charges, chargesTotal: money(charges.total), priceAt: fill.priceAt }, db);
      const base = { userId, orderId, token: order.instrument.token };
      const what = `${order.side} ${fill.qty} ${order.instrument.symbol} at ₹${price.toFixed(2)}`;
      const entries: NewLedgerRow[] = [];
      if (created.chargesTotal.gt(0)) entries.push({ ...base, type: 'CHARGES', amount: ZERO.minus(created.chargesTotal), fillId: created.id, note: `charges on ${what}` });
      if (!pos) {
        const freed = proportionalRelease(pendingMargin(rows, orderId), fill.qty, remaining);
        if (freed.gt(0)) entries.push({ ...base, type: 'MARGIN_RELEASE', amount: freed, note: `pending margin for the ${fill.qty} filled units` });
        const block = marginFor(order.vehicle, price.mul(fill.qty), settings);
        if (block.gt(0)) entries.push({ ...base, type: 'MARGIN_BLOCK', amount: ZERO.minus(block), fillId: created.id, note: `margin at the fill price for ${what}` });
      } else {
        const { realised } = applyPositionFill(pos.state, { side: order.side, qty: fill.qty, price, at: fill.priceAt });
        entries.push({ ...base, type: 'REALISED_PNL', amount: realised ?? ZERO, fillId: created.id, note: `realised on ${what}` });
        const release = proportionalRelease(pos.blocked, fill.qty, Math.abs(pos.state.netQty));
        if (release.gt(0)) entries.push({ ...base, type: 'MARGIN_RELEASE', amount: release, fillId: created.id, note: `margin released in proportion to ${what}` });
      }
      await this.ledger.append(entries, db);
      return updated;
    }));
  }

  /**
   * Ruling P10, for a NONE decision that carries `triggered: true`: the price at `at` first
   * reached this SL_MARKET order's trigger but nothing filled. Persists triggeredAt so the
   * stop fills as MARKET on the next fresh price. Null when the order is gone, closed, not
   * a stop, or no longer matches `expected` (a fill or a modify since, ruling P17); an already-triggered stop is returned
   * unchanged (a stop never un-triggers and keeps its first trigger time). A FILL decision
   * with `triggered: true` goes through applyFill with `fill.triggered` instead.
   */
  async markTriggered(userId: string, orderId: string, expected: OrderExpectation, at: Date): Promise<CoreOrder | null> {
    return this.emitted(this.tx.run(userId, async (db) => {
      const order = await this.orders.findForUser(userId, orderId, db);
      if (!order || !isOpenState(order.state) || order.type !== 'SL_MARKET' || !matchesExpectation(order, expected)) return null;
      if (order.triggeredAt !== null) return order;
      return this.orders.update(userId, orderId, { state: order.state, filledQty: order.filledQty }, { triggeredAt: at }, db);
    }));
  }

  /**
   * Change qty, limit or trigger of an open order; its pending margin follows (blocked more
   * only if funded). 404 unknown; 409 closed, or an SL_MARKET already executing (triggered
   * or partly filled, ruling P11); 422 a change the order cannot take.
   */
  async modify(userId: string, orderId: string, patch: CoreOrderPatch, now: Date = new Date()): Promise<CoreOrder> {
    const loaded = await this.defaults.settings(now.getTime());
    if (!loaded.ok) throw new UnprocessableEntityException(`paper settings are incomplete: ${loaded.missing.join(', ')}`);
    const settings = loaded.settings;
    return this.emitted(this.tx.run(userId, async (db) => {
      const order = await this.orders.findForUser(userId, orderId, db);
      if (!order) throw new NotFoundException(`core order ${orderId} not found`);
      if (!isOpenState(order.state)) throw new ConflictException(`core order ${orderId} is ${order.state}; it cannot be modified`);
      if (order.type === 'SL_MARKET' && (order.triggeredAt !== null || order.filledQty > 0)) {
        throw new ConflictException(`core order ${orderId} is a triggered stop; it is executing and cannot be modified`);
      }
      const next = {
        ...order,
        qty: patch.qty ?? order.qty,
        limitPrice: patch.limitPrice ?? order.limitPrice,
        triggerPrice: patch.triggerPrice ?? order.triggerPrice,
      };
      const rows = await this.ledger.listForUser(userId, db);
      const problem = await this.modifyProblem(order, patch, settings, rows, db);
      if (problem) throw new UnprocessableEntityException(problem);

      const entries: NewLedgerRow[] = [];
      if (order.purpose === 'ENTRY') {
        const target = marginFor(order.vehicle, marginRefPrice(next).mul(next.qty - next.filledQty), settings);
        const delta = target.minus(pendingMargin(rows, orderId));
        const base = { userId, orderId, token: order.instrument.token };
        if (delta.gt(0)) {
          const free = balances(rows).freeCash;
          if (free.lt(delta)) throw new UnprocessableEntityException(`insufficient free cash: the change blocks ₹${delta.toFixed(2)} more, ₹${free.toFixed(2)} is free`);
          entries.push({ ...base, type: 'MARGIN_BLOCK', amount: ZERO.minus(delta), note: 'margin for the modified order' });
        } else if (delta.lt(0)) {
          entries.push({ ...base, type: 'MARGIN_RELEASE', amount: ZERO.minus(delta), note: 'margin freed by the modified order' });
        }
      }
      const updated = await this.orders.update(
        userId,
        orderId,
        { state: order.state, filledQty: order.filledQty },
        { qty: next.qty, limitPrice: next.limitPrice, triggerPrice: next.triggerPrice },
        db,
      );
      if (!updated) throw new ConflictException(`core order ${orderId} changed while modifying; retry`);
      await this.ledger.append(entries, db);
      return updated;
    }));
  }

  /** Every non-flat position of the user, from fills; margin from the ledger (rows with a fillId). */
  async positions(userId: string): Promise<CorePositionView[]> {
    const [orders, fills, rows] = await Promise.all([this.orders.listForUser(userId), this.fills.listForUser(userId), this.ledger.listForUser(userId)]);
    const byId = new Map(orders.map((o) => [o.id, o]));
    const groups = new Map<string, { latest: CoreOrder; ids: Set<string>; state: PositionState }>();
    for (const o of orders) {
      const key = positionKey(o);
      const g = groups.get(key) ?? { latest: o, ids: new Set<string>(), state: FLAT };
      g.latest = o;
      g.ids.add(o.id);
      groups.set(key, g);
    }
    for (const f of fills) {
      const o = byId.get(f.orderId);
      if (!o) continue;
      const g = groups.get(positionKey(o));
      if (!g) continue;
      g.state = applyPositionFill(g.state, { side: o.side, qty: f.qty, price: f.price, at: f.priceAt }).state;
    }
    const out: CorePositionView[] = [];
    for (const [key, g] of groups) {
      if (g.state.netQty === 0 || !g.state.avgPrice || !g.state.openedAt) continue;
      out.push({
        key,
        vehicle: g.latest.vehicle,
        instrument: g.latest.instrument,
        netQty: g.state.netQty,
        direction: g.state.netQty > 0 ? 'LONG' : 'SHORT',
        avgPrice: g.state.avgPrice.toFixed(4),
        realisedPnl: g.state.realised.toFixed(2),
        blockedMargin: heldMargin(rows, (r) => r.orderId !== null && g.ids.has(r.orderId) && r.fillId !== null).toFixed(2),
        openedAt: g.state.openedAt,
      });
    }
    return out;
  }

  /**
   * Nightly MTF interest (spec §4.4, plan ruling 10): for every open MTF holding, one
   * MTF_INTEREST row per IST calendar day from the day after the last posting (or the
   * opening day) through `today`, each funded amount × mtfAnnualRatePct ÷ 365. The
   * unique (userId, token, interestDate) index makes a rerun post nothing; a missed night
   * or a weekend is caught up. A holding closed before the run is not charged for that
   * day (it is flat when scanned). Fails loudly (the job run is recorded FAILED) without
   * settings. listMtfHolders is the permitted cross-user scan; each holding is then read
   * and written under its own user.
   */
  async postMtfInterest(today: string): Promise<{ holdings: number; posted: number }> {
    const loaded = await this.defaults.settings();
    if (!loaded.ok) throw new Error(`paper settings are incomplete: ${loaded.missing.join(', ')}`);
    const settings = loaded.settings;
    let holdings = 0;
    let posted = 0;
    for (const { userId, token } of await this.orders.listMtfHolders()) {
      const r = await this.tx.run(userId, async (db) => {
        const { netQty, avgPrice, openedAt } = (await this.positionContext(userId, 'MTF', token, [], db)).state;
        if (netQty <= 0 || !avgPrice || !openedAt) return { held: 0, n: 0 };
        const days = mtfInterestDays(istDate(openedAt), await this.ledger.lastInterestDate(userId, token, db), today);
        const funded = mtfFunded(avgPrice.mul(netQty), settings);
        const amount = ZERO.minus(dailyMtfInterest(funded, settings.mtfAnnualRatePct));
        const note = `MTF interest on ₹${funded.toFixed(2)} funded at ${settings.mtfAnnualRatePct.toFixed(2)} percent a year`;
        const n = await this.ledger.appendInterest(
          days.map((interestDate) => ({ userId, type: 'MTF_INTEREST' as const, amount, token, interestDate, note })),
          db,
        );
        return { held: 1, n };
      });
      holdings += r.held;
      posted += r.n;
    }
    return { holdings, posted };
  }

  /**
   * Why `patch` cannot apply to `order`; null when it can. The lot-multiple, max-lots and
   * price-shape rules are fill-model's (ruling P7), not restated here.
   */
  private async modifyProblem(order: CoreOrder, patch: CoreOrderPatch, settings: PaperSettings, rows: readonly LedgerEntry[], db: PaperDb): Promise<string | null> {
    if (patch.qty === undefined && patch.limitPrice === undefined && patch.triggerPrice === undefined) return 'nothing to modify';
    if (patch.limitPrice !== undefined && order.type !== 'LIMIT') return 'only a LIMIT order has a limit price';
    if (patch.triggerPrice !== undefined && order.type !== 'SL_MARKET') return 'only an SL_MARKET order has a trigger price';
    for (const [name, v] of [['limitPrice', patch.limitPrice], ['triggerPrice', patch.triggerPrice]] as const) {
      const problem = v === undefined ? null : priceShapeProblem(v, name);
      if (problem) return problem;
    }
    if (patch.qty === undefined) return null;
    const lot = order.instrument.lotSize;
    if (!isWholeLots(patch.qty, lot)) return `qty must be a whole multiple of the lot size ${lot}`;
    if (patch.qty <= order.filledQty) return `qty must stay above the ${order.filledQty} units already filled`;
    if (order.vehicle === 'OPTIONS_BUY') {
      const problem = maxLotsProblem(patch.qty, lot, order.instrument.underlying, settings.maxLotsPerOrder);
      if (problem) return problem;
    }
    if (order.purpose === 'EXIT') {
      const pos = await this.positionContext(order.userId, order.vehicle, order.instrument.token, rows, db);
      const others = pos.pendingExitQty - (order.qty - order.filledQty);
      if (patch.qty - order.filledQty > Math.abs(pos.state.netQty) - others) return 'the exit would exceed the open position';
    }
    return null;
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

  /** The newest fill priceAt of each listed order that has fills (the matcher's snapshot guard). */
  async lastFillPriceAts(userId: string, orderIds: readonly string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    for (const f of await this.fills.listForOrders(userId, orderIds)) {
      const seen = out.get(f.orderId);
      if (!seen || f.priceAt.getTime() > seen.getTime()) out.set(f.orderId, f.priceAt);
    }
    return out;
  }

  openOrdersForUser(userId: string): Promise<CoreOrder[]> {
    return this.orders.listOpenForUser(userId);
  }

  /** SP2 M4 (ruling L3): every committed order change; returns the unsubscribe. */
  onOrderUpdate(fn: (order: CoreOrder) => void): () => void {
    return this.events.subscribe(fn);
  }

  /** SP2 M4: one core position's orders, oldest first. */
  listPositionOrders(userId: string, positionId: string): Promise<CoreOrder[]> {
    return this.orders.listForPositionId(userId, positionId);
  }

  /**
   * SP2 M4: today's (IST) net realised P&L per core position: REALISED_PNL plus CHARGES rows
   * of the position's orders. MTF interest is per holding (token), not per position, so it
   * counts in dayStats' user total only.
   */
  async netPnlTodayByPosition(userId: string, now: Date): Promise<Map<string, Dec>> {
    const day = istDate(now);
    const [rows, orders] = await Promise.all([this.ledger.listForUser(userId), this.orders.listForUser(userId)]);
    const positionOf = new Map(orders.filter((o) => o.positionId).map((o) => [o.id, o.positionId as string]));
    const out = new Map<string, Dec>();
    for (const r of rows) {
      if ((r.type !== 'REALISED_PNL' && r.type !== 'CHARGES') || r.orderId === null || istDate(r.createdAt) !== day) continue;
      const pid = positionOf.get(r.orderId);
      if (pid) out.set(pid, (out.get(pid) ?? ZERO).plus(r.amount));
    }
    return out;
  }

  /** Emit a committed order (null: nothing was written). */
  private async emitted<T extends CoreOrder | null>(write: Promise<T>): Promise<T> {
    const o = await write;
    if (o) this.events.emit(o);
    return o;
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
