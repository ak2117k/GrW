import { BadRequestException, ConflictException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { lookupHubPrices, type HubPriceSource, type HubPrices } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type InstrumentRef } from '../../market-hub/hub.types';
import type { SessionClock } from '../../market-hub/session-clock';
import type { CoreInstrument, CoreOrder, ExecutionAdapter } from '../execution/execution.types';
import { istDate } from '../execution/ledger-math';
import { CORE_EXECUTION_ADAPTER } from '../execution/paper-execution.adapter';
import { CorePaperDefaultsService } from '../execution/services/core-paper-defaults.service';
import { CORE_SESSION_CLOCK } from '../risk-wall/ports';
import { exposureOf } from '../risk-wall/risk-wall';
import type { CoreEntryIntent, LimitInForce } from '../risk-wall/risk-wall.types';
import { CoreKillSwitchReader } from '../risk-wall/services/core-kill-switch.reader';
import { CoreRiskLimitService } from '../risk-wall/services/core-risk-limit.service';
import type { StrategyBlocks } from '../strategies/blocks/block-types';
import { CoreStrategyRepository } from '../strategies/repositories/core-strategy.repository';
import { armLevels, buildExitPlan, type OptionOpen } from './exit-plan';
import { LIFECYCLE_EVENT_SINK, type LifecycleEventSink } from './lifecycle-events';
import { entryKey, isActiveStatus, type CorePosition, type LifecycleEvent, type LifecycleEventType, type PositionPatch } from './lifecycle.types';
import { reducePosition } from './position-state';
import { ActivePositionExistsError, CorePositionRepository } from './repositories/core-position.repository';
import { tightenStop } from './stop-rules';

/** Spec §7.2: the clock-rule sweep. */
export const LIFECYCLE_SWEEP_MS = 1_000;
/** Ruling L3: how often each held position's orders are re-read (missed updates). */
export const ORDERS_REREAD_MS = 5_000;

/** Spec §7.2: the hub watch owner of one core position. */
export const corePositionOwner = (positionId: string): string => `core:${positionId}`;

/** What M5 hands the lifecycle after an ALLOW/RESIZE verdict. */
export interface CoreOpenRequest {
  intent: CoreEntryIntent;
  /** The verdict's quantity (≤ intent.qty, whole lots). */
  qty: number;
  /** The resolved contract; its symbol must equal intent.symbol (ruling L19). */
  instrument: CoreInstrument;
  /** ATR at entry in price units (stop.atr and trail.atr use it), or null. */
  atr: number | null;
  /** The verdict's limits snapshot (squareOffTime, mtfMaxHoldDays are frozen from it). */
  limits: readonly LimitInForce[];
  /** OPTIONS_BUY only. */
  option: OptionOpen | null;
}

export interface LifecycleMark {
  ltp: number;
  /** Receipt time, ms epoch. */
  at: number;
}

interface Held {
  pos: CorePosition;
  ref: InstrumentRef | null;
  underlyingRef: InstrumentRef | null;
  hub: HubPrices | null;
  lastPrice: LifecycleMark | null;
  underlyingPrice: LifecycleMark | null;
  /** Marks changed in memory and not yet written (ruling L11). */
  dirty: boolean;
  /** Reloaded on boot: a stop crossed on the first fresh price is a RECOVERY_STOP. */
  recovering: boolean;
  /** The IST day of the last fresh price evaluated (GAP_STOP). */
  lastPricedDay: string | null;
  /** When this process began holding it (the blind clock never starts earlier). */
  since: number;
  /** When this process last saw the session open for it (the blind clock restarts at each open). */
  sessionSince: number | null;
  lastReread: number;
  lastExitAttempt: number;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function refOf(exchange: string, token: string, symbol: string): InstrumentRef | null {
  const ex = exchange.toUpperCase();
  return isHubExchange(ex) ? { exchange: ex, token, symbol } : null;
}

function addTo(index: Map<string, Set<string>>, key: string, id: string): void {
  const ids = index.get(key) ?? new Set<string>();
  ids.add(id);
  index.set(key, ids);
}

function removeFrom(index: Map<string, Set<string>>, key: string, id: string): void {
  const ids = index.get(key);
  ids?.delete(id);
  if (ids && ids.size === 0) index.delete(key);
}

/** What openPosition refuses before anything is written. */
function openProblem(r: CoreOpenRequest): string | null {
  const i = r.intent;
  if (i.kind !== 'ENTRY') return 'not an entry intent';
  if (!Number.isSafeInteger(r.qty) || r.qty < 1 || r.qty > i.qty) return `qty must be a whole number from 1 to the intent's ${i.qty} (the verdict may only reduce)`;
  if (r.instrument.lotSize !== i.lotSize || r.qty % r.instrument.lotSize !== 0) return `qty must be whole lots of ${i.lotSize}`;
  if (r.instrument.exchange.toUpperCase() !== i.exchange.toUpperCase()) return `the instrument trades on ${r.instrument.exchange}, the intent on ${i.exchange}`;
  if (r.instrument.symbol.toUpperCase() !== i.symbol.toUpperCase()) return `instrument ${r.instrument.symbol} is not the intent's ${i.symbol}`;
  if ((i.vehicle === 'OPTIONS_BUY') !== (r.option !== null)) return 'an option contract is required for OPTIONS_BUY, and only for it';
  if (r.option && r.option.optionType !== i.optionType) return `the contract is ${r.option.optionType}, the intent ${String(i.optionType)}`;
  return null;
}

/**
 * The Position Manager (spec §7). Holds every active core position in memory, watches
 * each at P0 on its user's hub, follows its orders (update stream + 5 s re-read), decides
 * exits on prices and on a 1 s sweep, and places every exit as a MARKET order through the
 * ExecutionAdapter. The database is the source of truth: every decision is persisted
 * (version-guarded) before its order is placed, and boot reloads every active position.
 * One position's work is serialised (run); one position's failure never stops the others.
 */
@Injectable()
export class CoreLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoreLifecycleService.name);
  private readonly held = new Map<string, Held>();
  private readonly byRef = new Map<string, Set<string>>();
  private readonly byUnderlying = new Map<string, Set<string>>();
  private readonly subscriptions = new Map<HubPrices, () => void>();
  private readonly inflight = new Map<string, Promise<void>>();
  private unsubscribeOrders: (() => void) | null = null;
  private hubSourceRef: HubPriceSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly repo: CorePositionRepository,
    @Inject(CORE_EXECUTION_ADAPTER) private readonly adapter: ExecutionAdapter,
    private readonly strategies: CoreStrategyRepository,
    private readonly defaults: CorePaperDefaultsService,
    private readonly limits: CoreRiskLimitService,
    private readonly killSwitch: CoreKillSwitchReader,
    private readonly moduleRef: ModuleRef,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen' | 'isTradingDay'>,
    @Inject(LIFECYCLE_EVENT_SINK) private readonly sink: LifecycleEventSink,
  ) {}

  /** Order updates always flow; the sweep (which writes and places exits) only in a serving process. */
  onModuleInit(): void {
    this.subscribe();
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    this.timer = setInterval(() => void this.sweep(), LIFECYCLE_SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeOrders?.();
    this.unsubscribeOrders = null;
    for (const off of this.subscriptions.values()) off();
    this.subscriptions.clear();
  }

  subscribe(): void {
    if (!this.unsubscribeOrders) this.unsubscribeOrders = this.adapter.onOrderUpdate((o) => void this.onOrderUpdate(o));
  }

  activeCount(): number {
    return this.held.size;
  }

  /** The newest price this process has for the position (the risk provider checks its age). */
  mark(positionId: string): LifecycleMark | null {
    return this.held.get(positionId)?.lastPrice ?? null;
  }

  /** Resolves when no position has work in flight (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  positionsFor(userId: string, since: Date | null): Promise<CorePosition[]> {
    return this.repo.listForUser(userId, since);
  }

  /**
   * Spec §3/§7.1: an ALLOWed (or RESIZEd) intent becomes a PENDING_ENTRY position and one
   * MARKET entry order keyed `${intentId}:entry`. Idempotent on the intent id. Refuses,
   * before writing anything, what it cannot plan; a version that is not PAPER (SP2 is paper
   * only); a second active position on the instrument (409).
   */
  async openPosition(req: CoreOpenRequest, now: Date = new Date()): Promise<CorePosition> {
    const i = req.intent;
    const prior = await this.repo.findByIntent(i.intentId);
    if (prior) {
      if (prior.userId !== i.userId) throw new ConflictException('this intent id belongs to another position');
      return prior;
    }
    const problem = openProblem(req);
    if (problem) throw new BadRequestException(`cannot open a core position: ${problem}`);
    const version = await this.strategies.findVersion(i.strategyVersionId);
    if (!version || version.strategyId !== i.strategyId) throw new BadRequestException(`strategy version ${i.strategyVersionId} of ${i.strategyId} not found`);
    if (version.status !== 'PAPER') throw new BadRequestException(`strategy version ${i.strategyVersionId} is ${version.status}; only PAPER versions trade in SP2`);
    const planned = buildExitPlan({
      blocks: version.blocks as unknown as StrategyBlocks,
      vehicle: i.vehicle,
      side: i.side,
      refPrice: i.refPrice,
      atr: req.atr,
      limits: req.limits,
      option: req.option,
      now,
    });
    if (!planned.ok) throw new BadRequestException(`cannot open a core position: ${planned.error}`);

    let pos: CorePosition;
    try {
      pos = await this.repo.createIfNoActive({
        userId: i.userId,
        intentId: i.intentId,
        strategyId: i.strategyId,
        strategyVersionId: i.strategyVersionId,
        vehicle: i.vehicle,
        instrument: req.instrument,
        underlying: i.underlying.trim().toUpperCase(),
        side: i.side,
        direction: exposureOf(i.vehicle, i.side, i.optionType),
        requestedQty: req.qty,
        plan: planned.plan,
      });
    } catch (err) {
      if (err instanceof ActivePositionExistsError) throw new ConflictException(err.message);
      throw err;
    }
    const h = this.hold(pos, now.getTime(), false);
    h.lastPricedDay = istDate(now);
    this.record('POSITION_STATE', h, { from: null, to: 'PENDING_ENTRY', qty: req.qty }, now);
    await this.run(pos.id, async () => {
      try {
        await this.adapter.placeOrder({
          userId: i.userId,
          idempotencyKey: entryKey(i.intentId),
          vehicle: i.vehicle,
          instrument: req.instrument,
          side: i.side,
          qty: req.qty,
          type: 'MARKET',
          limitPrice: null,
          triggerPrice: null,
          refPrice: i.refPrice,
          purpose: 'ENTRY',
          strategyVersionId: i.strategyVersionId,
          positionId: pos.id,
        });
      } catch (err) {
        // Never leave a PENDING_ENTRY ghost that blocks the instrument and counts as open risk.
        await this.persist(h, { status: 'CANCELLED', closedAt: new Date() });
        this.record('POSITION_STATE', h, { from: 'PENDING_ENTRY', to: 'CANCELLED', reason: `entry not placed: ${errorText(err)}` }, new Date());
        this.release(h);
        throw err;
      }
      await this.applyOrders(h, new Date());
    });
    return h.pos;
  }

  /** The adapter's update stream (ruling L3): re-reduce the owning position. */
  async onOrderUpdate(order: CoreOrder): Promise<void> {
    if (!order.positionId) return;
    let h = this.held.get(order.positionId);
    if (!h) {
      const pos = await this.repo.findForUser(order.userId, order.positionId);
      if (!pos || !isActiveStatus(pos.status)) return;
      h = this.hold(pos, Date.now(), false);
    }
    const held = h;
    await this.run(held.pos.id, () => this.applyOrders(held, new Date())).catch((err) =>
      this.logger.error(`core position ${held.pos.id}: order update failed: ${errorText(err)}`),
    );
  }

  /** Every second (spec §7.2). Task 9 adds prices, blind detection and decisions; Task 10 the boot reload. */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const h of [...this.held.values()]) {
        if (this.inflight.has(h.pos.id)) continue;
        await this.run(h.pos.id, () => this.sweepOne(h, now)).catch((err) => this.logger.error(`core position ${h.pos.id}: sweep failed: ${errorText(err)}`));
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOne(h: Held, now: number): Promise<void> {
    if (h.pos.openQty > 0) this.attachHub(h);
    if (now - h.lastReread >= ORDERS_REREAD_MS) await this.applyOrders(h, new Date(now));
  }

  /**
   * Re-reduce the position from its orders (ruling L2) and persist what changed: quantities,
   * the entry average, the levels armed at the first entry fill (L4), the status, closedAt.
   */
  private async applyOrders(h: Held, now: Date): Promise<void> {
    h.lastReread = now.getTime();
    const pos = h.pos;
    if (!isActiveStatus(pos.status)) return;
    const orders = await this.adapter.listPositionOrders(pos.userId, pos.id);
    if (orders.length === 0 && pos.status === 'PENDING_ENTRY' && h.recovering) {
      // Created but never given its entry (a crash in between): never enter late.
      await this.persist(h, { status: 'CANCELLED', closedAt: now });
      this.record('POSITION_STATE', h, { from: 'PENDING_ENTRY', to: 'CANCELLED', reason: 'no entry order was placed before the restart' }, now);
      this.release(h);
      return;
    }
    const f = reducePosition(pos.status, orders);
    const patch: PositionPatch = {};
    if (f.entryFilledQty !== pos.entryFilledQty) patch.entryFilledQty = f.entryFilledQty;
    if (f.exitFilledQty !== pos.exitFilledQty) patch.exitFilledQty = f.exitFilledQty;
    if (f.entryAvgPrice !== pos.entryAvgPrice) patch.entryAvgPrice = f.entryAvgPrice;
    if (f.entryAvgPrice !== null && (pos.entryAvgPrice === null || patch.entryFilledQty !== undefined)) {
      const lv = armLevels(pos.plan, f.entryAvgPrice, f.entryFilledQty, pos.instrument.lotSize);
      Object.assign(patch, { targetPrice: lv.targetPrice, partialPrice: lv.partialPrice, partialQty: lv.partialQty });
      if (pos.stopPrice === null) {
        const trail = pos.plan.trail;
        Object.assign(patch, {
          initialStopPrice: lv.stopPrice,
          stopPrice: lv.stopPrice,
          highWater: f.entryAvgPrice,
          lowWater: f.entryAvgPrice,
          openedAt: pos.openedAt ?? now,
          trailActive: trail.kind === 'atr' && trail.startsAfter === 'ENTRY',
        });
      } else {
        const t = tightenStop(pos.stopPrice, lv.stopPrice, pos.side);
        if (t.accepted) patch.stopPrice = t.stop;
      }
    }
    if (f.status !== pos.status) {
      patch.status = f.status;
      if (f.status === 'CLOSED' || f.status === 'CANCELLED') patch.closedAt = now;
    }
    if (Object.keys(patch).length === 0) return;
    const updated = await this.persist(h, { ...this.pendingMarks(h), ...patch });
    if (!updated) return;
    if (updated.status !== pos.status) {
      this.record(
        'POSITION_STATE',
        h,
        { from: pos.status, to: updated.status, entryFilledQty: updated.entryFilledQty, exitFilledQty: updated.exitFilledQty, exitReason: updated.exitReason },
        now,
      );
    }
    if (!isActiveStatus(updated.status)) this.release(h);
    else if (updated.openQty > 0) this.attachHub(h);
  }

  /** Version-guarded write (ruling L11). A lost race reloads the row and returns null. */
  private async persist(h: Held, patch: PositionPatch): Promise<CorePosition | null> {
    const updated = await this.repo.update(h.pos.userId, h.pos.id, h.pos.version, patch);
    if (!updated) {
      const fresh = await this.repo.findForUser(h.pos.userId, h.pos.id);
      this.logger.warn(`core position ${h.pos.id}: a concurrent write won; reloaded`);
      if (fresh) h.pos = fresh;
      h.dirty = false;
      return null;
    }
    h.pos = updated;
    h.dirty = false;
    return updated;
  }

  /** The in-memory marks not yet written (ruling L11); empty when nothing is dirty. */
  private pendingMarks(h: Held): PositionPatch {
    return h.dirty ? { stopPrice: h.pos.stopPrice, highWater: h.pos.highWater, lowWater: h.pos.lowWater, trailActive: h.pos.trailActive } : {};
  }

  private hold(pos: CorePosition, now: number, recovering: boolean): Held {
    // Already held (a reload or a late update): keep the in-memory copy, which may carry unflushed marks.
    const existing = this.held.get(pos.id);
    if (existing) return existing;
    const u = pos.plan.option?.underlyingRef ?? null;
    const h: Held = {
      pos,
      ref: refOf(pos.instrument.exchange, pos.instrument.token, pos.instrument.symbol),
      underlyingRef: u ? { exchange: u.exchange, token: u.token, symbol: u.symbol } : null,
      hub: null,
      lastPrice: null,
      underlyingPrice: null,
      dirty: false,
      recovering,
      lastPricedDay: null,
      since: now,
      sessionSince: null,
      lastReread: now,
      lastExitAttempt: 0,
    };
    this.held.set(pos.id, h);
    if (h.ref) addTo(this.byRef, refKey(h.ref), pos.id);
    if (h.underlyingRef) addTo(this.byUnderlying, refKey(h.underlyingRef), pos.id);
    if (pos.openQty > 0) this.attachHub(h);
    return h;
  }

  /** A terminal position: stop holding it and drop its watches. */
  private release(h: Held): void {
    if (this.held.get(h.pos.id) !== h) return;
    this.held.delete(h.pos.id);
    if (h.ref) removeFrom(this.byRef, refKey(h.ref), h.pos.id);
    if (h.underlyingRef) removeFrom(this.byUnderlying, refKey(h.underlyingRef), h.pos.id);
    if (h.hub) {
      const refs = [h.ref, h.underlyingRef].filter((r): r is InstrumentRef => r !== null);
      void h.hub.unwatch(refs, corePositionOwner(h.pos.id));
    }
  }

  private hubSource(): HubPriceSource | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    return this.hubSourceRef;
  }

  /** Spec §7.2: P0 for the instrument, P1 for an option's underlying stop; one subscription per hub. */
  private attachHub(h: Held): void {
    if (h.hub || !h.ref) return;
    const hub = this.hubSource()?.hubFor(h.pos.userId, 'positions') ?? null;
    if (!hub) return;
    h.hub = hub;
    if (!this.subscriptions.has(hub)) this.subscriptions.set(hub, hub.onPrice((p) => void this.onPrice(hub, p)));
    void hub.watch([h.ref], 0, corePositionOwner(h.pos.id));
    if (h.underlyingRef) void hub.watch([h.underlyingRef], 1, corePositionOwner(h.pos.id));
  }

  /** Ruling L12: never awaited, never thrown into a decision. */
  private record(type: LifecycleEventType, h: Held, payload: Record<string, unknown>, at: Date, price: LifecycleMark | null = null): void {
    const e: LifecycleEvent = {
      type,
      userId: h.pos.userId,
      positionId: h.pos.id,
      strategyVersionId: h.pos.strategyVersionId,
      payload,
      priceUsed: price?.ltp ?? null,
      priceAgeMs: price ? at.getTime() - price.at : null,
      at,
    };
    void this.sink.record(e).catch((err) => this.logger.error(`lifecycle event ${type} for ${h.pos.id} not recorded: ${errorText(err)}`));
  }

  /**
   * One position's work, in order; the returned promise carries fn's result or error. The
   * in-flight mark is cleared in `finally`, before any awaiter of the result resumes, so a
   * caller that awaited run() never sees its own finished work as still in flight.
   */
  private run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inflight.get(id) ?? Promise.resolve();
    let tail: Promise<void> | null = null;
    const result = prev.then(fn).finally(() => {
      if (this.inflight.get(id) === tail) this.inflight.delete(id);
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.set(id, tail);
    return result;
  }

  /** Task 8: record the mark of the positions this ref prices (Task 9 adds the decisions). */
  onPrice(hub: HubPrices, p: import('../../market-hub/hub.types').Price, _now: number = Date.now()): Promise<void> {
    for (const id of this.byRef.get(refKey(p.ref)) ?? []) {
      const h = this.held.get(id);
      if (h && h.hub === hub && (!h.lastPrice || p.at > h.lastPrice.at)) h.lastPrice = { ltp: p.ltp, at: p.at };
    }
    return Promise.resolve();
  }
}
