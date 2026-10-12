import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { lookupHubPrices, type HubPriceSource, type HubPrices } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type InstrumentRef, type Price } from '../../market-hub/hub.types';
import type { SessionClock } from '../../market-hub/session-clock';
import type { CoreInstrument, CoreOrder, ExecutionAdapter, OrderSide } from '../execution/execution.types';
import { PRICE_MAX_AGE_MS } from '../execution/fill-model';
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
import { armLevels, buildExitPlan, round2, type OptionOpen } from './exit-plan';
import { decideExit, effectiveHoldDays, effectiveSquareOff, tradingDaysHeld } from './exit-decision';
import { LIFECYCLE_EVENT_SINK, type LifecycleEventSink } from './lifecycle-events';
import { entryKey, exitKey, isActiveStatus, outranks, type CorePosition, type ExitReason, type LifecycleEvent, type LifecycleEventType, type PositionPatch } from './lifecycle.types';
import { reducePosition } from './position-state';
import { ActivePositionExistsError, CorePositionRepository } from './repositories/core-position.repository';
import { advanceMarks, tightenStop } from './stop-rules';

/** Spec §7.2: the clock-rule sweep. */
export const LIFECYCLE_SWEEP_MS = 1_000;
/** Ruling L3: how often each held position's orders are re-read (missed updates). */
export const ORDERS_REREAD_MS = 5_000;

/** Ruling L7: live limits are re-read at most this often per user. */
export const LIVE_LIMITS_CACHE_MS = 5_000;

/** A price this process may act on: fresh (spec §6.3) and not from the future. */
export function fresh(p: LifecycleMark | null, now: number): LifecycleMark | null {
  return p && p.at <= now && now - p.at <= PRICE_MAX_AGE_MS ? p : null;
}

const opposite = (side: OrderSide): OrderSide => (side === 'BUY' ? 'SELL' : 'BUY');

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
  private loaded = false;
  /** The boot reload in progress, shared by the sweep and exitAll (review fix 1). */
  private recovery: Promise<void> | null = null;
  private readonly liveLimitCache = new Map<string, { at: number; squareOff: ReadonlyMap<string, string>; mtfMaxHoldDays: number | null }>();

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

  /**
   * Spec §7.6, on boot (the first sweep): load every user's active positions, re-watch them at
   * P0, re-read their orders. An EXITING position is re-placed by ensureExit with the same key
   * (claimSeq); the first fresh price past the stop exits as RECOVERY_STOP.
   */
  async recover(now: number = Date.now()): Promise<number> {
    // System work, even when a user's request triggers it (exitAll before the first sweep):
    // CorePosition and CoreOrder are tenant-scoped, and a scoped reload would hold only that
    // user's positions, and read the others' orders as empty, with loaded then true for good.
    return this.repo.withoutTenant(async () => {
      const active = await this.repo.listActive();
      for (const pos of active) {
        const h = this.hold(pos, now, true);
        await this.run(pos.id, () => this.applyOrders(h, new Date(now))).catch((err) => this.logger.error(`core position ${pos.id}: recovery failed: ${errorText(err)}`));
      }
      this.loaded = true;
      this.logger.log(`lifecycle: recovered ${active.length} active core position(s)`);
      return active.length;
    });
  }

  /** The boot reload, once: a caller that arrives while it runs awaits the same one; a failure lets the next caller retry. */
  private ensureLoaded(now: number = Date.now()): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (!this.recovery) {
      this.recovery = this.recover(now)
        .then(() => undefined)
        .finally(() => {
          this.recovery = null;
        });
    }
    return this.recovery;
  }

  /**
   * CORE_POSITION_EXITS (Task 11): exit every active core position of the user, kill switch
   * (priority 1) or daily loss (priority 2). Exits are never blocked; outside the session they
   * are re-placed at the next open by ensureExit. Throws after trying all, so the cascade
   * reports FAILED rather than a partial OK.
   */
  async exitAll(userId: string, cause: 'KILL_SWITCH' | 'DAILY_LOSS', reason: string): Promise<{ exitsRequested: number }> {
    await this.ensureLoaded();
    const mine = [...this.held.values()].filter((h) => h.pos.userId === userId && isActiveStatus(h.pos.status));
    const failures: string[] = [];
    let requested = 0;
    for (const h of mine) {
      try {
        await this.run(h.pos.id, async () => {
          const now = Date.now();
          await this.exit(h, cause, reason, now, fresh(h.lastPrice, now));
        });
        requested += 1;
      } catch (err) {
        failures.push(`${h.pos.id}: ${errorText(err)}`);
      }
    }
    if (failures.length > 0) throw new Error(`requested ${requested} of ${mine.length} core position exits; failed: ${failures.join('; ')}`);
    return { exitsRequested: requested };
  }

  /** SP3/SP4 guard rails (SP3 spec §9): a stop may only tighten (spec §7.4). */
  async proposeStop(userId: string, positionId: string, proposed: number, source: string, now: number = Date.now()): Promise<{ accepted: boolean; stopPrice: number | null }> {
    const h = this.mine(userId, positionId);
    return this.run(positionId, async () => {
      const pos = h.pos;
      if (!isActiveStatus(pos.status) || pos.status === 'EXITING' || pos.entryAvgPrice === null) return { accepted: false, stopPrice: pos.stopPrice };
      const t = tightenStop(pos.stopPrice, proposed, pos.side);
      if (!t.accepted) {
        this.record('STOP_MOVED', h, { source, proposed, accepted: false, stop: pos.stopPrice }, new Date(now));
        return { accepted: false, stopPrice: pos.stopPrice };
      }
      const updated = await this.persist(h, { ...this.pendingMarks(h), stopPrice: t.stop });
      if (!updated) return { accepted: false, stopPrice: h.pos.stopPrice };
      this.record('STOP_MOVED', h, { source, from: pos.stopPrice, to: t.stop, why: 'GUARD_RAIL', accepted: true }, new Date(now));
      return { accepted: true, stopPrice: t.stop };
    });
  }

  /** A guard rail or the owner asks for an exit (ranked with the stop, priority 3). */
  async requestExit(userId: string, positionId: string, reason: 'GUARD_RAIL' | 'MANUAL', note: string, now: number = Date.now()): Promise<CorePosition> {
    const h = this.mine(userId, positionId);
    await this.run(positionId, async () => {
      await this.exit(h, reason, note, now, fresh(h.lastPrice, now));
    });
    return h.pos;
  }

  private mine(userId: string, positionId: string): Held {
    const h = this.held.get(positionId);
    if (!h || h.pos.userId !== userId) throw new NotFoundException(`active core position ${positionId} not found`);
    return h;
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

  /** A hub push (spec §7.2, the main path): evaluate the positions this ref prices, at once. */
  onPrice(hub: HubPrices, p: Price, now: number = Date.now()): Promise<void> {
    const key = refKey(p.ref);
    const runs: Array<Promise<void>> = [];
    for (const id of this.byRef.get(key) ?? []) {
      const h = this.held.get(id);
      if (!h || h.hub !== hub) continue;
      if (!h.lastPrice || p.at > h.lastPrice.at) h.lastPrice = { ltp: p.ltp, at: p.at };
      runs.push(this.evaluate(h, now));
    }
    for (const id of this.byUnderlying.get(key) ?? []) {
      const h = this.held.get(id);
      if (!h || h.hub !== hub) continue;
      if (!h.underlyingPrice || p.at > h.underlyingPrice.at) h.underlyingPrice = { ltp: p.ltp, at: p.at };
      runs.push(this.evaluate(h, now));
    }
    return Promise.all(runs).then(() => undefined);
  }

  /** Every second (spec §7.2): prices from the hub's book, re-reads, blind detection, clock rules, exit re-placement, mark flush. */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.ensureLoaded(now);
      const blindAfterMs = await this.blindAfterMs(now);
      for (const h of [...this.held.values()]) {
        if (this.inflight.has(h.pos.id)) continue;
        await this.run(h.pos.id, () => this.sweepOne(h, now, blindAfterMs)).catch((err) => this.logger.error(`core position ${h.pos.id}: sweep failed: ${errorText(err)}`));
      }
    } catch (err) {
      this.logger.error(`lifecycle sweep failed: ${errorText(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOne(h: Held, now: number, blindAfterMs: number): Promise<void> {
    if (h.pos.openQty > 0) this.attachHub(h);
    if (h.hub && h.ref) {
      const r = h.hub.price(h.ref, { maxAgeMs: PRICE_MAX_AGE_MS });
      if (r.kind === 'fresh' && (!h.lastPrice || r.price.at > h.lastPrice.at)) h.lastPrice = { ltp: r.price.ltp, at: r.price.at };
    }
    if (h.hub && h.underlyingRef) {
      const r = h.hub.price(h.underlyingRef, { maxAgeMs: PRICE_MAX_AGE_MS });
      if (r.kind === 'fresh' && (!h.underlyingPrice || r.price.at > h.underlyingPrice.at)) h.underlyingPrice = { ltp: r.price.ltp, at: r.price.at };
    }
    const open = this.clock.isOpen(h.pos.instrument.exchange, new Date(now));
    h.sessionSince = open ? (h.sessionSince ?? now) : null;
    if (now - h.lastReread >= ORDERS_REREAD_MS) await this.applyOrders(h, new Date(now));
    if (this.held.get(h.pos.id) !== h) return;
    await this.checkBlind(h, now, blindAfterMs);
    await this.decide(h, now);
    await this.ensureExit(h, now);
    if (h.dirty && this.held.get(h.pos.id) === h) await this.persist(h, this.pendingMarks(h));
  }

  /** Skip when this position already has work in flight: a push and the sweep never both decide. */
  private evaluate(h: Held, now: number): Promise<void> {
    if (this.inflight.has(h.pos.id)) return Promise.resolve();
    return this.run(h.pos.id, () => this.decide(h, now)).catch((err) => this.logger.error(`core position ${h.pos.id}: evaluation failed: ${errorText(err)}`));
  }

  /** One position, one instant: marks and trail on a fresh price, then decideExit (spec §7.3). Runs inside run(). */
  private async decide(h: Held, now: number): Promise<void> {
    const pos = h.pos;
    if (!isActiveStatus(pos.status) || pos.openQty <= 0 || pos.entryAvgPrice === null) return;
    const at = new Date(now);
    if (!this.clock.isOpen(pos.instrument.exchange, at)) return; // ruling L9
    const price = fresh(h.lastPrice, now);
    const today = istDate(at);
    const firstPriceOfDay = price !== null && h.lastPricedDay !== today;
    if (price) {
      const m = advanceMarks(
        { side: pos.side, plan: pos.plan, entryAvgPrice: pos.entryAvgPrice, stopPrice: pos.stopPrice, trailActive: pos.trailActive, partialDone: pos.partialDone, highWater: pos.highWater, lowWater: pos.lowWater },
        price.ltp,
      );
      if (m.highWater !== pos.highWater || m.lowWater !== pos.lowWater || m.stopPrice !== pos.stopPrice || m.trailActive !== pos.trailActive) {
        h.pos = { ...pos, highWater: m.highWater, lowWater: m.lowWater, stopPrice: m.stopPrice, trailActive: m.trailActive };
        h.dirty = true;
        if (m.stopMoved) this.record('STOP_MOVED', h, { from: pos.stopPrice, to: m.stopPrice, why: m.stopMoved }, at, price);
      }
    }
    if (h.pos.status !== 'EXITING') {
      const rules = await this.liveRules(pos.userId, now);
      const d = decideExit({
        position: h.pos,
        price,
        underlyingLtp: fresh(h.underlyingPrice, now)?.ltp ?? null,
        now: at,
        sessionOpen: true,
        killSwitchActive: await this.killSwitchOn(pos.userId),
        squareOffHhmm: effectiveSquareOff(pos.plan.squareOffHhmm, rules.squareOff.get(pos.vehicle) ?? null),
        mtfMaxHoldDays: effectiveHoldDays(pos.plan.mtfMaxHoldDays, rules.mtfMaxHoldDays),
        tradingDaysHeld: tradingDaysHeld(this.clock, pos.instrument.exchange, pos.plan.entryDay, at),
        recovering: h.recovering,
        firstPriceOfDay,
      });
      if (d.kind === 'EXIT') {
        if (d.reason === 'RECOVERY_STOP') this.record('RECOVERY_STOP', h, { stop: h.pos.stopPrice, detail: d.detail }, at, price);
        await this.exit(h, d.reason, d.detail, now, price);
      } else if (d.kind === 'PARTIAL') {
        await this.partial(h, d.qty, d.detail, now, price);
      }
    }
    if (price) {
      h.lastPricedDay = today;
      h.recovering = false;
    }
  }

  /**
   * Decide a full exit (spec §7.3): persist EXITING and the reason first (Review Focus 2), then
   * place. A position already exiting keeps its order; a higher-priority reason replaces the
   * recorded one. Runs inside run(). Returns the quantity sent.
   */
  private async exit(h: Held, reason: ExitReason, detail: string, now: number, price: LifecycleMark | null): Promise<number> {
    const pos = h.pos;
    if (!isActiveStatus(pos.status)) return 0;
    if (pos.status !== 'EXITING' || outranks(reason, pos.exitReason)) {
      const updated = await this.persist(h, { ...this.pendingMarks(h), status: 'EXITING', exitReason: reason });
      if (!updated) return 0;
      this.record('EXIT_DECIDED', h, { reason, detail, from: pos.status, stop: pos.stopPrice, target: pos.targetPrice }, new Date(now), price);
      if (pos.status !== 'EXITING') this.record('POSITION_STATE', h, { from: pos.status, to: 'EXITING', exitReason: reason }, new Date(now));
    }
    return this.placeExit(h, now);
  }

  /** Target 1 (spec §7.5): sell the partial quantity once; a trail that waits for it starts now. */
  private async partial(h: Held, qty: number, detail: string, now: number, price: LifecycleMark | null): Promise<void> {
    const pos = h.pos;
    const startsTrail = pos.plan.trail.kind === 'atr' && pos.plan.trail.startsAfter === 'PARTIAL';
    const updated = await this.persist(h, { ...this.pendingMarks(h), partialDone: true, trailActive: pos.trailActive || startsTrail });
    if (!updated) return;
    this.record('EXIT_DECIDED', h, { reason: 'PARTIAL_TARGET', partial: true, qty, detail }, new Date(now), price);
    if (qty <= 0) return;
    const orders = await this.adapter.listPositionOrders(pos.userId, pos.id);
    const f = reducePosition(h.pos.status, orders);
    const send = Math.min(qty, f.openQty - f.pendingExitQty);
    if (send <= 0) return;
    const seq = await this.claimSeq(h, orders);
    if (seq === null) return;
    const o = await this.adapter.placeOrder(this.exitRequest(h, seq, send, price?.ltp ?? h.pos.entryAvgPrice));
    if (o.state === 'REJECTED') this.logger.warn(`core position ${pos.id}: partial ${o.idempotencyKey} rejected (${o.rejectReason}); not retried (ruling L17)`);
    await this.applyOrders(h, new Date(now));
  }

  /**
   * Rulings L1/L3: one MARKET exit for what is open and not already being exited. An open
   * entry remainder is cancelled first, so nothing more is bought while exiting.
   */
  private async placeExit(h: Held, now: number): Promise<number> {
    h.lastExitAttempt = now;
    const pos = h.pos;
    let orders = await this.adapter.listPositionOrders(pos.userId, pos.id);
    let f = reducePosition(pos.status, orders);
    if (f.openEntry) {
      await this.adapter.cancel(pos.userId, f.openEntry.id);
      orders = await this.adapter.listPositionOrders(pos.userId, pos.id);
      f = reducePosition(pos.status, orders);
    }
    const qty = f.openQty - f.pendingExitQty;
    if (qty > 0) {
      const seq = await this.claimSeq(h, orders);
      if (seq === null) return 0;
      const o = await this.adapter.placeOrder(this.exitRequest(h, seq, qty, h.lastPrice?.ltp ?? f.entryAvgPrice));
      if (o.state === 'REJECTED') this.logger.warn(`core position ${pos.id}: exit ${o.idempotencyKey} rejected (${o.rejectReason}); the sweep re-places it`);
    }
    await this.applyOrders(h, new Date(now));
    return Math.max(qty, 0);
  }

  /**
   * The exit sequence to use, persisted BEFORE the order is placed (Review Focus 2): the
   * current one if no order has used its key yet (recovery re-places the same key), else the next.
   */
  private async claimSeq(h: Held, orders: readonly CoreOrder[]): Promise<number | null> {
    const cur = h.pos.exitSeq;
    if (cur > 0 && !orders.some((o) => o.idempotencyKey === exitKey(h.pos.intentId, cur))) return cur;
    const next = cur + 1;
    return (await this.persist(h, { ...this.pendingMarks(h), exitSeq: next })) ? next : null;
  }

  private exitRequest(h: Held, seq: number, qty: number, ref: number | null) {
    const pos = h.pos;
    return {
      userId: pos.userId,
      idempotencyKey: exitKey(pos.intentId, seq),
      vehicle: pos.vehicle,
      instrument: pos.instrument,
      side: opposite(pos.side),
      qty,
      type: 'MARKET' as const,
      limitPrice: null,
      triggerPrice: null,
      refPrice: round2(ref ?? pos.entryAvgPrice ?? 0),
      purpose: 'EXIT' as const,
      strategyVersionId: pos.strategyVersionId,
      positionId: pos.id,
    };
  }

  /** Review Focus 1: an EXITING position with nothing being exited is re-placed, in session, at most every 5 s. Runs inside run(). */
  private async ensureExit(h: Held, now: number): Promise<void> {
    if (h.pos.status !== 'EXITING' || now - h.lastExitAttempt < ORDERS_REREAD_MS) return;
    if (!this.clock.isOpen(h.pos.instrument.exchange, new Date(now))) return;
    await this.placeExit(h, now);
  }

  /** Spec §7.2: no fresh price for blindAfterMs while the session is open → BLIND (journaled, warned); a fresh price clears it. */
  private async checkBlind(h: Held, now: number, blindAfterMs: number): Promise<void> {
    const pos = h.pos;
    if (!isActiveStatus(pos.status) || pos.openQty <= 0 || h.sessionSince === null) return;
    const noPriceForMs = now - Math.max(h.lastPrice?.at ?? 0, h.since, h.sessionSince);
    const blind = noPriceForMs > blindAfterMs;
    if (blind && !pos.blindSince) {
      if (await this.persist(h, { ...this.pendingMarks(h), blindSince: new Date(now) })) {
        this.record('BLIND', h, { blind: true, noPriceForMs }, new Date(now));
        this.logger.warn(`core position ${pos.id} (${pos.instrument.symbol}) is BLIND: no fresh price for ${noPriceForMs} ms`);
      }
    } else if (!blind && pos.blindSince) {
      if (await this.persist(h, { ...this.pendingMarks(h), blindSince: null })) this.record('BLIND', h, { blind: false }, new Date(now));
    }
  }

  /** Ruling L7: the user's live squareOffTime per vehicle and mtfMaxHoldDays, cached 5 s; unreadable → frozen values only. */
  private async liveRules(userId: string, now: number): Promise<{ squareOff: ReadonlyMap<string, string>; mtfMaxHoldDays: number | null }> {
    const c = this.liveLimitCache.get(userId);
    if (c && now - c.at < LIVE_LIMITS_CACHE_MS) return c;
    let limits: LimitInForce[] = [];
    try {
      limits = await this.limits.inForce(userId, new Date(now));
    } catch (err) {
      this.logger.warn(`live limits unreadable for ${userId}; the frozen values apply: ${errorText(err)}`);
    }
    const n = Number(limits.find((l) => l.key === 'mtfMaxHoldDays' && l.scope === 'MTF')?.value ?? Number.NaN);
    const entry = {
      at: now,
      squareOff: new Map(limits.filter((l) => l.key === 'squareOffTime').map((l) => [l.scope as string, l.value] as const)),
      mtfMaxHoldDays: Number.isSafeInteger(n) ? n : null,
    };
    this.liveLimitCache.set(userId, entry);
    return entry;
  }

  /** An unreadable switch is never a reason to exit: positions keep their stops (Global Constraints). */
  private async killSwitchOn(userId: string): Promise<boolean> {
    try {
      return await this.killSwitch.isOn(userId);
    } catch (err) {
      this.logger.error(`core kill switch unreadable for ${userId}; positions keep their stops: ${errorText(err)}`);
      return false;
    }
  }

  /** Ruling L10: the optional paper default, or PRICE_MAX_AGE_MS (stricter) when absent or unreadable. */
  private async blindAfterMs(now: number): Promise<number> {
    try {
      const r = await this.defaults.settings(now);
      if (r.ok && r.settings.blindAfterMs !== null) return r.settings.blindAfterMs;
    } catch (err) {
      this.logger.warn(`paper settings unreadable; blind after ${PRICE_MAX_AGE_MS} ms: ${errorText(err)}`);
    }
    return PRICE_MAX_AGE_MS;
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
}
