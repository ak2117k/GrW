import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lookupHubPrices, type HubPriceSource, type HubPrices } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type InstrumentRef, type Price } from '../../market-hub/hub.types';
import type { SessionClock } from '../../market-hub/session-clock';
import { CORE_SESSION_CLOCK } from '../risk-wall/ports';
import type { CoreOrder } from './execution.types';
import { decideFill, noPriceDeadline, priceProblem, PRICE_MAX_AGE_MS, type FillPrice } from './fill-model';
import { isOpenState } from './order-state';
import { PaperLedgerService } from './paper-ledger.service';
import { CorePaperDefaultsService } from './services/core-paper-defaults.service';

/** Spec §4.6: the sweep's period. */
export const MATCHER_SWEEP_MS = 1_000;

/** The hub watch owner of one core order (spec §4.6). */
export const coreOrderOwner = (orderId: string): string => `core-order:${orderId}`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface Tracked {
  order: CoreOrder;
  ref: InstrumentRef | null;
  key: string;
  hub: HubPrices | null;
  /** When an unpriced order is rejected; pushed forward by closed-session time (ruling P16a). */
  deadline: number;
  /** The last instant the countdown has accounted for (closed-session time before it is already added). */
  countedTo: number;
  noPriceRejectMs: number;
  /** It has seen a usable price (fresh, after submission, in session): never rejected for want of one. */
  priced: boolean;
  /** An evaluation or a reject is in flight for it in this process. */
  busy: boolean;
}

/**
 * Approach A (E5, spec §4.6): open core orders in memory, keyed by EXCHANGE:token, and
 * evaluated on every hub price push for their ref and on a 1 s sweep. The DB is the
 * source of truth: every state change is written by PaperLedgerService first, and the
 * first sweep after boot reloads every open order. Fail closed: a missing hub, a closed
 * session, a stale price or missing settings never fills; an order that sees no usable
 * price by its deadline is rejected "no fresh price". One order's failure is logged and
 * that order is retried on the next price; it never stops the others.
 */
@Injectable()
export class PaperMatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaperMatcherService.name);
  private readonly tracked = new Map<string, Tracked>();
  private readonly byKey = new Map<string, Set<string>>();
  private readonly subscriptions = new Map<HubPrices, () => void>();
  private hubSourceRef: HubPriceSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loaded = false;
  private sweeping = false;

  constructor(
    private readonly ledger: PaperLedgerService,
    private readonly defaults: CorePaperDefaultsService,
    private readonly moduleRef: ModuleRef,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), MATCHER_SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }

  openCount(): number {
    return this.tracked.size;
  }

  isTracked(orderId: string): boolean {
    return this.tracked.has(orderId);
  }

  /** Start matching an open order (after placement, or on reload). Idempotent. */
  track(order: CoreOrder, noPriceRejectMs: number, now: number = Date.now()): void {
    if (!isOpenState(order.state) || this.tracked.has(order.id)) return;
    const exchange = order.instrument.exchange.toUpperCase();
    const ref: InstrumentRef | null = isHubExchange(exchange) ? { exchange, token: order.instrument.token, symbol: order.instrument.symbol } : null;
    const key = ref ? refKey(ref) : `${exchange}:${order.instrument.token}`;
    // Ruling P4: after a reload the deadline restarts from the reload time.
    const deadline = noPriceDeadline(order.submittedAt.getTime(), now, noPriceRejectMs);
    const t: Tracked = {
      order,
      ref,
      key,
      hub: null,
      deadline,
      countedTo: deadline - noPriceRejectMs,
      noPriceRejectMs,
      // Ruling P16a: a reloaded order that has filled or triggered has already seen a usable price.
      priced: order.filledQty > 0 || order.triggeredAt !== null,
      busy: false,
    };
    this.tracked.set(order.id, t);
    const ids = this.byKey.get(key) ?? new Set<string>();
    ids.add(order.id);
    this.byKey.set(key, ids);
    this.attachHub(t);
  }

  /** Replace the in-memory copy after a modify or a close (the DB already holds it). */
  refresh(order: CoreOrder): void {
    const t = this.tracked.get(order.id);
    if (!t) return;
    if (!isOpenState(order.state)) this.untrack(order.id);
    else t.order = order;
  }

  /** Stop matching an order and drop its hub watch. */
  untrack(orderId: string): void {
    const t = this.tracked.get(orderId);
    if (!t) return;
    this.tracked.delete(orderId);
    const ids = this.byKey.get(t.key);
    ids?.delete(orderId);
    if (ids && ids.size === 0) this.byKey.delete(t.key);
    if (t.hub && t.ref) void t.hub.unwatch([t.ref], coreOrderOwner(orderId));
  }

  /** A hub push: evaluate this ref's orders that this hub prices. Never throws into the hub. */
  onPrice(hub: HubPrices, p: Price, now: number = Date.now()): Promise<void> {
    const ids = this.byKey.get(refKey(p.ref));
    if (!ids) return Promise.resolve();
    const runs: Array<Promise<void>> = [];
    for (const id of [...ids]) {
      const t = this.tracked.get(id);
      if (t && t.hub === hub) runs.push(this.evaluate(t, p, now));
    }
    return Promise.all(runs).then(() => undefined);
  }

  /** Every second: reload once after boot, reject expired unpriced orders, evaluate the rest from the hub's book. */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      if (!this.loaded) await this.reload(now);
      for (const t of [...this.tracked.values()]) {
        if (!this.tracked.has(t.order.id) || t.busy) continue;
        if (!t.priced && this.noPriceExpired(t, now)) {
          await this.rejectNoPrice(t);
          continue;
        }
        this.attachHub(t);
        if (!t.hub || !t.ref) continue;
        const r = t.hub.price(t.ref, { maxAgeMs: PRICE_MAX_AGE_MS });
        if (r.kind === 'fresh') await this.evaluate(t, r.price, now);
      }
    } catch (err) {
      this.logger.error(`paper matcher sweep failed: ${errorText(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** Boot: every open order from the DB, re-watched. Without settings nothing is loaded (retried next sweep). */
  async reload(now: number = Date.now()): Promise<void> {
    const loaded = await this.defaults.settings(now);
    if (!loaded.ok) {
      this.logger.error(`paper settings are incomplete (${loaded.missing.join(', ')}); open core orders are not matched`);
      return;
    }
    const open = await this.ledger.openOrders();
    for (const o of open) this.track(o, loaded.settings.noPriceRejectMs, now);
    this.loaded = true;
    if (open.length > 0) this.logger.log(`reloaded ${open.length} open core order(s)`);
  }

  /**
   * Ruling P16a: the no-price countdown runs only while the order's session is open. A
   * sweep that finds the session closed pushes the deadline forward by the time since the
   * last instant counted, so a restart outside market hours rejects nothing; once open,
   * noPriceRejectMs of open-session time with no usable price rejects the order.
   */
  private noPriceExpired(t: Tracked, now: number): boolean {
    const open = this.clock.isOpen(t.order.instrument.exchange, new Date(now));
    if (!open && now > t.countedTo) t.deadline += now - t.countedTo;
    t.countedTo = Math.max(t.countedTo, now);
    return open && now > t.deadline;
  }

  private hubSource(): HubPriceSource | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    return this.hubSourceRef;
  }

  /** Watch the order's ref at P0 on the user's hub and subscribe to that hub's pushes (once per hub). */
  private attachHub(t: Tracked): void {
    if (t.hub || !t.ref) return;
    const hub = this.hubSource()?.hubFor(t.order.userId, 'positions') ?? null;
    if (!hub) return;
    t.hub = hub;
    if (!this.subscriptions.has(hub)) this.subscriptions.set(hub, hub.onPrice((p) => void this.onPrice(hub, p)));
    void hub.watch([t.ref], 0, coreOrderOwner(t.order.id));
  }

  /**
   * One order against one price. A FILL goes through applyFill (with `triggered` when the
   * decision carries it); a NONE that first reached an SL_MARKET trigger is persisted with
   * markTriggered (ruling P10). Both are guarded by the filledQty this copy holds, so a
   * stale copy (another process, a restart) writes nothing and is refreshed from the DB.
   * A throw is logged and the order stays tracked: the next price retries it, and the
   * no-price deadline still bounds an order that never saw a usable one.
   */
  private async evaluate(t: Tracked, p: FillPrice, now: number): Promise<void> {
    if (t.busy) return;
    t.busy = true;
    try {
      if (!this.tracked.has(t.order.id)) return;
      if (priceProblem(p, t.order.submittedAt.getTime(), now) !== null) return;
      if (!this.clock.isOpen(t.order.instrument.exchange, new Date(now))) return;
      t.priced = true;
      const loaded = await this.defaults.settings(now);
      if (!loaded.ok) return;
      const decision = decideFill(t.order, p, now, loaded.settings.slippageBps[t.order.vehicle]);
      const priceAt = new Date(p.at);
      let updated: CoreOrder | null;
      if (decision.kind === 'FILL') {
        updated = await this.ledger.applyFill(
          t.order.userId,
          t.order.id,
          t.order.filledQty,
          { qty: decision.qty, price: decision.price, priceAt, ...(decision.triggered ? { triggered: true } : {}) },
          new Date(now),
        );
      } else if (decision.triggered) {
        updated = await this.ledger.markTriggered(t.order.userId, t.order.id, t.order.filledQty, priceAt);
      } else {
        return;
      }
      const current = updated ?? (await this.ledger.findOrder(t.order.userId, t.order.id));
      if (!current || !isOpenState(current.state)) this.untrack(t.order.id);
      else t.order = current;
    } catch (err) {
      this.logger.error(`core order ${t.order.id}: evaluation failed: ${errorText(err)}`);
    } finally {
      t.busy = false;
    }
  }

  private async rejectNoPrice(t: Tracked): Promise<void> {
    t.busy = true;
    try {
      const o = await this.ledger.close(t.order.userId, t.order.id, 'REJECT', `no fresh price after submission (waited ${t.noPriceRejectMs} ms)`);
      if (!isOpenState(o.state)) this.untrack(t.order.id);
      else {
        t.order = o;
        t.priced = o.filledQty > 0;
      }
    } catch (err) {
      this.logger.error(`core order ${t.order.id}: no-price reject failed: ${errorText(err)}`);
    } finally {
      t.busy = false;
    }
  }
}
