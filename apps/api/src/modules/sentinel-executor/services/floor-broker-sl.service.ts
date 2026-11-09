// apps/api/src/modules/sentinel-executor/services/floor-broker-sl.service.ts
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { FLOOR_STATE_BOARD, type FloorState, type FloorStateBoard } from '../../floor-board/floor-state.board';
import type { CandleRepo } from '../../market-hub/candles/candle-repository';
import type { SessionClock } from '../../market-hub/session-clock';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import type { AutoExitConfig } from '../domain/auto-exit.types';
import { tickRupees } from '../domain/exit-order';
import {
  desiredFloorStop,
  floorStopTag,
  parseFloorBrokerSlConfig,
  planFloorStop,
  simulateStopFill,
  type FloorBrokerSlConfig,
  type RestingStop,
  type StopStep,
} from '../domain/floor-broker-sl';
import { FloorBrokerSlRepository, type FloorSlEventInput, type FloorSlTracker } from '../repositories/floor-broker-sl.repository';
import { AI_EXIT_SESSION_CLOCK } from './executor.tokens';
import { SentinelExitExecutor, type FloorStopIntent, type FloorStopResult } from './sentinel-exit-executor.service';

/** One pass every 15 s (the cycle publishes a floor every ~30 s; a modify is rate-limited to ≥ 15 s anyway). */
export const FLOOR_SL_PASS_MS = 15_000;
/** A board entry older than this is not trusted: nothing new is placed or moved on it (a resting stop is KEPT). */
export const FLOOR_STATE_STALE_MS = 120_000;
/** The comparison waits this long after the exit so the exit minute's 1m bar is in candles_1m. */
export const COMPARE_DELAY_MS = 120_000;
/** Look-back for restart memory and pending comparisons. */
const HISTORY_MS = 3 * 24 * 3600_000;
const COMPARE_EVERY_PASSES = 4;
/** DI seam for tests; production uses the process-wide board the sentinel cycle publishes to. */
export const FLOOR_SL_BOARD = Symbol('FLOOR_SL_BOARD');
/** DI seam: the 1m candle reader (EXIT_OUTCOME_CANDLES in the module). */
export const FLOOR_SL_CANDLES = Symbol('FLOOR_SL_CANDLES');

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Virtual = RestingStop & { floor: number };

/**
 * FLOOR_BROKER_SL (domain/floor-broker-sl.ts). Every pass, for each open F&O position of the AI auto-exit's
 * allow-listed users that the sentinel owns, whose noise floor is ARMED on a fresh cycle reading:
 *  - shadow (default): plans the stop against a VIRTUAL resting stop and records PLACE / MODIFY / CANCEL /
 *    SKIP rows — no broker call of any kind — and, once the position has exited, one EXIT_COMPARE row: the
 *    stop's simulated fill on candles_1m vs the real exit.
 *  - live: hands the intents to SentinelExitExecutor.syncFloorStops (the executor's single place / cancel /
 *    modify call sites, its session lease and its exit-overlap lock) and records what it did.
 * Inert (no timer, no query) when off, BOOT_JOBS=false, the AI auto-exit is disabled or has no users. No @Cron.
 */
@Injectable()
export class FloorBrokerSlService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FloorBrokerSlService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private exit: AutoExitConfig | null = null;
  private cfg: FloorBrokerSlConfig | null = null;
  private readonly board: Pick<FloorStateBoard, 'get'>;
  /** shadow: trackerId → the virtual resting stop. */
  private readonly virtual = new Map<string, Virtual>();
  /** live: trackers we have seen a stop for (so a closed one gets its cancel). */
  private readonly liveTracked = new Map<string, FloorSlTracker>();
  /** trackerId → last SKIP / KEEP reason recorded (one row per change, not per pass). */
  private readonly lastNote = new Map<string, string>();
  private readonly inst = new Map<string, { tickSize: number | null; lotSize: number | null } | null>();
  private restored = false;
  private passes = 0;

  constructor(
    private readonly repo: FloorBrokerSlRepository,
    private readonly executor: SentinelExitExecutor,
    @Inject(AI_EXIT_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
    @Inject(FLOOR_SL_CANDLES) private readonly candles: Pick<CandleRepo, 'read'>,
    @Optional() @Inject(FLOOR_SL_BOARD) board?: Pick<FloorStateBoard, 'get'>,
  ) {
    this.board = board ?? FLOOR_STATE_BOARD;
  }

  onModuleInit(): void {
    const exit = parseAutoExitConfig(process.env);
    const cfg = parseFloorBrokerSlConfig(process.env, exit);
    for (const p of cfg.problems) this.logger.warn(`[floor-sl] ${p}`);
    if (cfg.mode === 'off') return void this.logger.log('[floor-sl] off (FLOOR_BROKER_SL=off)');
    if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
    if (!exit.enabled || exit.userIds.length === 0) return void this.logger.log('[floor-sl] inert: the AI auto-exit is disabled or has no users');
    this.use(exit, cfg);
    this.logger.warn(`[floor-sl] ${cfg.mode.toUpperCase()} — resting STOPLOSS-LIMIT at the armed noise floor, limit ${cfg.limitTicks} ticks, modify ≥ ${cfg.modifyMinSec}s apart`
      + (cfg.mode === 'shadow' ? ' (records only, places nothing)' : ' (REAL ORDERS)'));
    this.timer = setInterval(() => void this.runOnce(), FLOOR_SL_PASS_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Start configuration (onModuleInit; tests call it directly). */
  use(exit: AutoExitConfig, cfg: FloorBrokerSlConfig): void {
    this.exit = exit;
    this.cfg = cfg;
  }

  /** One pass. Single-flight; never throws. */
  async runOnce(now: Date = new Date()): Promise<void> {
    const exit = this.exit, cfg = this.cfg;
    if (!exit || !cfg || cfg.mode === 'off' || this.running) return;
    this.running = true;
    try {
      const mode = cfg.mode;
      if (!this.restored) await this.restore(mode, now);
      const open = await this.repo.openTrackers(exit.userIds);
      const openIds = new Set(open.map((t) => t.id));
      const intents = new Map<string, Array<{ t: FloorSlTracker; intent: FloorStopIntent; state: FloorState | null }>>();
      for (const t of open) {
        try {
          const ex = String(t.exchange).toUpperCase();
          if (!this.clock.isOpen(ex, now)) continue;
          const state = this.board.get(t.id);
          if (!state || now.getTime() - state.at > FLOOR_STATE_STALE_MS) continue; // no fresh floor: touch nothing
          const inst = await this.instrumentOf(t);
          const tick = tickRupees(inst?.tickSize, ex);
          const eligible = this.eligibility(t, state, exit);
          if (mode === 'shadow') await this.shadowStep(t, state, eligible, tick, inst?.lotSize ?? null, exit, cfg, now);
          else {
            const list = intents.get(t.userId) ?? [];
            list.push({ t, state, intent: this.intentOf(t, state, eligible, tick, inst?.lotSize ?? null) });
            intents.set(t.userId, list);
          }
        } catch (err) {
          this.logger.warn(`[floor-sl] ${t.symbol}: pass failed: ${errText(err)}`);
        }
      }
      if (mode === 'shadow') await this.shadowClosed(openIds, now);
      else await this.livePass(intents, openIds, exit, cfg, now);
      if (++this.passes % COMPARE_EVERY_PASSES === 1) await this.compare(mode, now);
    } catch (err) {
      this.logger.warn(`[floor-sl] pass failed: ${errText(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** Same eligibility as the hard-floor exit (guards.ts), plus SENTINEL ownership and an ARMED noise floor. */
  private eligibility(t: FloorSlTracker, s: FloorState, exit: AutoExitConfig): { ok: true } | { ok: false; reason: string } {
    if (!exit.userIds.includes(t.userId) || s.userId !== t.userId) return { ok: false, reason: 'NOT_ALLOWED_USER' };
    const hold = exit.hold ?? [];
    if ([t.symbol, t.id].some((k) => hold.includes(String(k).toUpperCase()))) return { ok: false, reason: 'OWNER_HOLD' };
    if (s.ownership !== 'SENTINEL') return { ok: false, reason: 'NOT_SENTINEL_OWNED' };
    if (!s.floor || s.floor.basis !== 'noise' || !s.floor.armed || !(s.floor.level > 0)) return { ok: false, reason: 'FLOOR_DISARMED' };
    return { ok: true };
  }

  private intentOf(t: FloorSlTracker, s: FloorState | null, eligible: FloorStopIntent['eligible'], tick: number, lotSize: number | null): FloorStopIntent {
    return {
      trackerId: t.id, symbol: t.symbol, exchange: String(t.exchange).toUpperCase(), token: t.token, trackerQty: t.qty,
      entryTime: t.entryTime ?? null, lotSize, tick, floor: s?.floor?.armed ? s.floor.level : null, eligible,
    };
  }

  /** The order quantity in the exchange's configured unit (R16); null when it cannot be expressed. */
  private shadowQty(t: FloorSlTracker, lot: number | null, exit: AutoExitConfig): { qty: number | null; unitVerified: boolean } {
    const units = Math.abs(t.qty);
    const unit = exit.qtyUnits[String(t.exchange).toUpperCase()];
    if (!unit) return { qty: Number.isInteger(units) ? units : null, unitVerified: false };
    if (unit === 'units') return { qty: Number.isInteger(units) ? units : null, unitVerified: true };
    return lot && lot > 1 && units % lot === 0 ? { qty: units / lot, unitVerified: true } : { qty: null, unitVerified: true };
  }

  private async shadowStep(
    t: FloorSlTracker, s: FloorState, eligible: { ok: true } | { ok: false; reason: string }, tick: number, lot: number | null,
    exit: AutoExitConfig, cfg: FloorBrokerSlConfig, now: Date,
  ): Promise<void> {
    const { qty, unitVerified } = this.shadowQty(t, lot, exit);
    const desired = eligible.ok
      ? desiredFloorStop({ side: s.side, floor: s.floor!.level, ltp: s.ltp, tick, limitTicks: cfg.limitTicks, quantity: qty ?? 0 })
      : null;
    const resting = this.virtual.get(t.id) ?? null;
    const action = planFloorStop({ eligible, desired, resting, tick, nowMs: now.getTime(), modifyMinSec: cfg.modifyMinSec });
    const base = { ...this.ids(t, 'shadow'), floorPrice: s.floor?.level ?? null, ltp: s.ltp, orderTag: floorStopTag(t.id), detail: unitVerified ? null : { unitVerified: false } };
    if (action.kind === 'PLACE' || action.kind === 'MODIFY') {
      const d = action.desired;
      this.virtual.set(t.id, { side: d.side, trigger: d.trigger, limit: d.limit, quantity: d.quantity, changedAt: now.getTime(), floor: s.floor!.level });
      this.lastNote.delete(t.id);
      await this.record({ ...base, action: action.kind, side: d.side, triggerPrice: d.trigger, limitPrice: d.limit, quantity: d.quantity,
        prevTriggerPrice: action.kind === 'MODIFY' ? action.from.trigger : null, reason: unitVerified ? null : 'UNIT_UNVERIFIED' });
      return;
    }
    if (action.kind === 'CANCEL') {
      this.virtual.delete(t.id);
      await this.record({ ...base, action: 'CANCEL', reason: action.reason, side: resting?.side ?? null, triggerPrice: resting?.trigger ?? null, limitPrice: resting?.limit ?? null, quantity: resting?.quantity ?? null });
      return;
    }
    if (action.kind === 'NONE' && this.lastNote.get(t.id) !== action.reason) {
      this.lastNote.set(t.id, action.reason);
      await this.record({ ...base, action: 'SKIP', reason: action.reason });
    }
  }

  /** shadow: a virtual stop whose position is no longer open is cancelled (the comparison scores it later). */
  private async shadowClosed(openIds: Set<string>, now: Date): Promise<void> {
    const gone = [...this.virtual.keys()].filter((id) => !openIds.has(id));
    if (gone.length === 0) return;
    for (const t of await this.repo.trackers(gone)) {
      const v = this.virtual.get(t.id);
      this.virtual.delete(t.id);
      if (!v) continue;
      await this.record({ ...this.ids(t, 'shadow'), action: 'CANCEL', reason: 'POSITION_CLOSED', side: v.side, triggerPrice: v.trigger, limitPrice: v.limit,
        quantity: v.quantity, exitPrice: t.exitPrice, exitAt: t.exitTime ?? now, orderTag: floorStopTag(t.id) });
    }
    for (const id of gone) this.virtual.delete(id);
  }

  private async livePass(
    intents: Map<string, Array<{ t: FloorSlTracker; intent: FloorStopIntent; state: FloorState | null }>>, openIds: Set<string>,
    exit: AutoExitConfig, cfg: FloorBrokerSlConfig, now: Date,
  ): Promise<void> {
    // Positions we had a stop for that are no longer open: one cancel request each (the executor checks the book).
    const gone = [...this.liveTracked.keys()].filter((id) => !openIds.has(id));
    for (const t of gone.length > 0 ? await this.repo.trackers(gone) : []) {
      const list = intents.get(t.userId) ?? [];
      list.push({ t, state: null, intent: this.intentOf(t, null, { ok: false, reason: 'POSITION_CLOSED' }, 0.05, null) });
      intents.set(t.userId, list);
    }
    for (const [userId, list] of intents) {
      const results = await this.executor.syncFloorStops(userId, list.map((x) => x.intent), { limitTicks: cfg.limitTicks, modifyMinSec: cfg.modifyMinSec, exit }, now);
      for (const r of results) {
        const x = list.find((y) => y.t.id === r.trackerId);
        if (x) await this.recordLive(x.t, x.state, r, now);
      }
    }
  }

  private async recordLive(t: FloorSlTracker, s: FloorState | null, r: FloorStopResult, now: Date): Promise<void> {
    const wrote = r.action === 'PLACE' || r.action === 'MODIFY';
    if (wrote || (r.action === 'KEEP' && r.trigger != null)) this.liveTracked.set(t.id, t);
    if (r.action === 'CANCEL' || r.action === 'FILLED' || (r.action === 'NONE' && r.reason === 'POSITION_CLOSED')) this.liveTracked.delete(t.id);
    const base = {
      ...this.ids(t, 'live'), floorPrice: s?.floor?.level ?? null, ltp: r.ltp ?? s?.ltp ?? null, orderTag: floorStopTag(t.id),
      side: r.side ?? null, triggerPrice: r.trigger ?? null, limitPrice: r.limit ?? null, prevTriggerPrice: r.prevTrigger ?? null,
      quantity: r.quantity ?? null, productType: r.productType ?? null, brokerOrderId: r.orderId ?? null,
      brokerStatus: r.brokerStatus ?? null, brokerMessage: r.brokerMessage ?? null, reason: r.reason ?? null,
    };
    if (r.action === 'PLACE' || r.action === 'MODIFY' || r.action === 'CANCEL' || r.action === 'ERROR') {
      this.lastNote.delete(t.id);
      await this.record({ ...base, action: r.action });
      return;
    }
    if (r.action === 'FILLED') {
      await this.record({ ...base, action: 'FILLED', exitPrice: r.fillPrice ?? null, exitAt: now });
      return;
    }
    const note = `${r.action}:${r.reason ?? ''}`;
    if (this.lastNote.get(t.id) !== note) {
      this.lastNote.set(t.id, note);
      await this.record({ ...base, action: r.action === 'KEEP' && r.trigger != null ? 'RECONCILE' : 'SKIP' });
    }
  }

  /** Restart memory: shadow rebuilds its virtual stops; live re-learns which positions had a stop (the book is the truth). */
  private async restore(mode: 'shadow' | 'live', now: Date): Promise<void> {
    try {
      const rows = await this.repo.stopHistory(mode, new Date(now.getTime() - HISTORY_MS));
      const last = new Map<string, (typeof rows)[number]>();
      for (const r of rows) last.set(r.trackerId, r);
      const alive = [...last.values()].filter((r) => r.action !== 'CANCEL' && r.triggerPrice != null && r.limitPrice != null);
      const trackers = new Map((await this.repo.trackers(alive.map((r) => r.trackerId))).map((t) => [t.id, t]));
      for (const r of alive) {
        const t = trackers.get(r.trackerId);
        if (!t) continue;
        if (mode === 'live') { this.liveTracked.set(t.id, t); continue; }
        this.virtual.set(r.trackerId, {
          side: r.side === 'BUY' ? 'BUY' : 'SELL', trigger: r.triggerPrice!, limit: r.limitPrice!, quantity: r.quantity ?? 0,
          changedAt: r.createdAt.getTime(), floor: r.triggerPrice!,
        });
      }
      this.restored = true;
    } catch (err) {
      this.logger.warn(`[floor-sl] restore failed (retried next pass): ${errText(err)}`);
    }
  }

  /**
   * EXIT_COMPARE: for each position that had a stop and has exited, the stop's simulated fill (the stop's own
   * PLACE / MODIFY / CANCEL steps on candles_1m, simulateStopFill) vs the real exit — the executor's fill when it
   * sold, else the tracker's exit price. saved_rupees = (stop fill − exit) × |qty| (sign-flipped for a short);
   * 0 when the stop would not have triggered (the exit happened above it).
   */
  private async compare(mode: 'shadow' | 'live', now: Date): Promise<void> {
    try {
      const since = new Date(now.getTime() - HISTORY_MS);
      const ids = await this.repo.pendingCompares(mode, since);
      if (ids.length === 0) return;
      const closed = (await this.repo.trackers(ids)).filter((t) => t.status !== 'OPEN' && t.exitTime && now.getTime() - t.exitTime.getTime() >= COMPARE_DELAY_MS);
      for (const t of closed) {
        // POSITION_CLOSED is recorded after the exit by definition: it ends nothing the comparison measures.
        const history = (await this.repo.stopHistory(mode, since, [t.id])).filter((h) => !(h.action === 'CANCEL' && h.reason === 'POSITION_CLOSED'));
        const steps: StopStep[] = history.map((h) => (h.action === 'CANCEL'
          ? { at: h.createdAt.getTime(), trigger: null, limit: null }
          : { at: h.createdAt.getTime(), trigger: h.triggerPrice, limit: h.limitPrice }));
        const first = history.find((h) => h.action === 'PLACE');
        if (!first) continue;
        const side = first.side === 'BUY' ? 'BUY' : 'SELL';
        const fill = await this.repo.exitFill(t.id);
        const actual = fill?.fillPrice ?? t.exitPrice;
        const exitAt = fill?.fillAt ?? t.exitTime!;
        if (actual == null) continue;
        const bars = await this.candles.read('1m', { exchange: String(t.exchange).toUpperCase() as never, token: t.token, symbol: t.symbol }, steps[0].at - 60_000, exitAt.getTime() + 60_000);
        const sim = simulateStopFill({ side, bars, steps, untilMs: exitAt.getTime(), actualExit: actual });
        const sign = side === 'SELL' ? 1 : -1;
        const qty = Math.abs(t.qty);
        const saved = sim.triggered && sim.fill != null ? (sim.fill - actual) * qty * sign : 0;
        const savedAtLimit = sim.triggered && sim.fillAtLimit != null ? (sim.fillAtLimit - actual) * qty * sign : 0;
        await this.record({
          ...this.ids(t, mode), action: 'EXIT_COMPARE', reason: sim.note, side, exitPrice: actual, exitAt,
          wouldFillPrice: sim.fill, wouldFillLimit: sim.fillAtLimit, wouldTriggerAt: sim.triggeredAt ? new Date(sim.triggeredAt) : null,
          savedRupees: Math.round(saved * 100) / 100, quantity: Number.isInteger(qty) ? qty : null, orderTag: floorStopTag(t.id),
          detail: { savedAtLimit: Math.round(savedAtLimit * 100) / 100, steps: steps.length, bars: bars.length, exitSource: fill ? 'ai_exit_fill' : 'tracker' },
        });
        this.logger.log(`[floor-sl] ${mode} compare ${t.symbol}: exit ${actual} vs stop ${sim.fill ?? '—'} (${sim.note}) → ₹${Math.round(saved)}`);
      }
    } catch (err) {
      this.logger.warn(`[floor-sl] compare failed: ${errText(err)}`);
    }
  }

  private ids(t: FloorSlTracker, mode: 'shadow' | 'live') {
    return { userId: t.userId, trackerId: t.id, symbol: t.symbol, exchange: String(t.exchange).toUpperCase(), token: t.token, mode };
  }

  private async instrumentOf(t: FloorSlTracker) {
    if (!this.inst.has(t.id)) this.inst.set(t.id, await this.repo.instrument(String(t.exchange).toUpperCase(), t.symbol));
    return this.inst.get(t.id) ?? null;
  }

  /** A row write must never stop the pass. */
  private async record(e: FloorSlEventInput): Promise<void> {
    try {
      await this.repo.record(e);
    } catch (err) {
      this.logger.warn(`[floor-sl] could not record ${e.action} for ${e.symbol}: ${errText(err)}`);
    }
  }
}
