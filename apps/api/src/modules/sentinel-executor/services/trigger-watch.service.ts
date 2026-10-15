// apps/api/src/modules/sentinel-executor/services/trigger-watch.service.ts
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { lookupHubPrices, type HubPrices } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type HubExchange, type InstrumentRef, type Price } from '../../market-hub/hub.types';
import type { SessionClock } from '../../market-hub/session-clock';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { AUTO_EXIT_EXCHANGES, type AutoExitConfig } from '../domain/auto-exit.types';
import { triggerVerdictId } from '../domain/manual-exit';
import { parseStoredTrigger } from '../domain/stored-trigger';
import { TriggerBook, type ArmedTrigger, type Fire } from '../domain/trigger-book';
import { parseTriggerConfig, type TriggerConfig } from '../domain/trigger-config';
import { contractKindOf, validateTrigger } from '../domain/trigger-rules';
import { TRIGGER_TIMING, TRIGGER_WATCH_OWNER } from '../domain/trigger.types';
import { EMPTY_CONFIRM } from '../domain/confirmation';
import { AiExitExecutionRepository, type PendingVerdict } from '../repositories/ai-exit-execution.repository';
import {
  SentinelExitTriggerRepository,
  type ProposalRow,
  type TriggerFields,
} from '../repositories/sentinel-exit-trigger.repository';
import { AI_EXIT_SESSION_CLOCK, SentinelExitExecutor } from './sentinel-exit-executor.service';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const sign = (op: 'BELOW' | 'ABOVE') => (op === 'BELOW' ? '<' : '>');

/** The executor row's verdictReason for a fire (ruling R13). */
export function firedReason(t: ArmedTrigger, tick: Fire['tick'], armedAtIst: string): string {
  return `PRICE_TRIGGER: ${t.watch.symbol} ${sign(t.op)} ${t.price} — fired at ${tick.price} ` +
    `(${tick.count} ticks over ${tick.heldMs} ms); armed ${armedAtIst} IST by verdict ${t.verdictId}`;
}

/**
 * Sentinel price triggers (docs/superpowers/specs/2026-10-13-sentinel-price-triggers-design.md §3).
 *
 * OFF unless SENTINEL_TRIGGERS_ENABLED=true AND the AI auto-exit is enabled with
 * an allow-list AND boot jobs run (ruling R11): then nothing — no timer, no hub
 * listener, no watch, no query. On: every 5 s one arming query (+ maintenance
 * every 30 s); the hub's onPrice stream feeds `TriggerBook.onTick`, the only tick
 * path, which does no I/O. A confirmed cross claims ARMED → FIRED and hands a
 * synthetic `trg_` verdict to the SAME guarded executor as an AI verdict.
 */
@Injectable()
export class TriggerWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriggerWatchService.name);
  private tcfg: TriggerConfig | null = null;
  private acfg: AutoExitConfig | null = null;
  private book: TriggerBook | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private booted = false;
  private lastMaintenance = 0;
  private readonly hubs = new Map<string, HubPrices>();
  private readonly subscribed = new Set<HubPrices>();
  private readonly unsubs: Array<() => void> = [];
  /** UNDERLYING refs this service registered on a hub, by key. */
  private readonly held = new Map<string, { ref: InstrumentRef; hub: HubPrices }>();
  /** Proposals waiting for their instrument to price (R9): verdictId → first seen + key. */
  private readonly deferred = new Map<string, { firstSeen: number; key: string | null }>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly repo: SentinelExitTriggerRepository,
    private readonly execRepo: AiExitExecutionRepository,
    private readonly executor: SentinelExitExecutor,
    private readonly moduleRef: ModuleRef,
    @Inject(AI_EXIT_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
  ) {}

  onModuleInit(): void {
    this.start(process.env);
  }

  /** The switch logic, env-injected for tests. true = started. */
  start(env: Record<string, string | undefined>): boolean {
    const tcfg = parseTriggerConfig(env);
    const acfg = parseAutoExitConfig(env);
    for (const p of tcfg.problems) this.logger.warn(`[ai-trigger] ${p}`);
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return false;
    }
    if (!tcfg.enabled) {
      this.logger.log('[ai-trigger] disabled (SENTINEL_TRIGGERS_ENABLED is not true)');
      return false;
    }
    if (!acfg.enabled || acfg.userIds.length === 0) {
      this.logger.error('[ai-trigger] SENTINEL_TRIGGERS_ENABLED=true but the AI auto-exit is off or has no allow-listed user — not starting');
      return false;
    }
    this.tcfg = tcfg;
    this.acfg = acfg;
    this.book = new TriggerBook({ ticks: tcfg.confirmTicks, ms: tcfg.confirmMs }, (ex, at) => this.clock.isOpen(ex, at));
    this.logger.warn(
      `[ai-trigger] ENABLED mode=${acfg.mode} confirm=${tcfg.confirmTicks} ticks/${tcfg.confirmMs} ms ` +
        `maxAge=${tcfg.maxAgeMin} min distance=U${tcfg.maxDistancePct.UNDERLYING}%/P${tcfg.maxDistancePct.PREMIUM}% ` +
        `tightenOnly=${tcfg.tightenOnly}`,
    );
    this.timer = setInterval(() => void this.pass(), TRIGGER_TIMING.passMs);
    this.timer.unref?.();
    return true;
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.unsubs.splice(0)) off();
    this.subscribed.clear();
    this.book = null;
  }

  /** THE tick path (hub listener). Synchronous; no I/O; never throws. */
  onPrice(p: Price): void {
    const book = this.book;
    if (!book) return;
    const fires = book.onTick({ key: refKey(p.ref), exchange: p.ref.exchange, ltp: p.ltp, at: p.at, source: p.source }, Date.now());
    for (const f of fires) void this.fire(f);
  }

  /** One background pass. Single-flight; a no-op unless started. */
  async pass(now: Date = new Date()): Promise<void> {
    if (!this.book || this.running) return;
    this.running = true;
    try {
      this.attachHubs();
      if (!this.booted) {
        await this.boot(now);
        this.booted = true;
      }
      await this.armPass(now);
      if (now.getTime() - this.lastMaintenance >= TRIGGER_TIMING.maintenanceMs) {
        this.lastMaintenance = now.getTime();
        await this.maintain(now);
      }
    } catch (err) {
      this.logger.warn(`[ai-trigger] pass failed: ${errText(err)}`);
    } finally {
      this.running = false;
    }
  }

  private attachHubs(): void {
    for (const userId of this.acfg?.userIds ?? []) {
      if (this.hubs.has(userId)) continue;
      const hub = lookupHubPrices(this.moduleRef)?.hubFor(userId, 'positions') ?? null;
      if (!hub) {
        this.warnOnce(`nohub:${userId}`, `[ai-trigger] no market hub serves ${userId} (MARKET_HUB_ENABLED / HUB_OWNER_USER_ID / HUB_PRICES_POSITIONS) — its triggers cannot arm`);
        continue;
      }
      this.hubs.set(userId, hub);
      // Triggers rebuilt at boot before this user's hub existed: watch their underlyings now.
      for (const t of this.book?.all() ?? []) {
        if (t.userId === userId && t.instrument === 'UNDERLYING') {
          this.hold({ exchange: t.watch.exchange as HubExchange, token: t.watch.token, symbol: t.watch.symbol }, hub);
        }
      }
      if (!this.subscribed.has(hub)) {
        this.subscribed.add(hub);
        this.unsubs.push(hub.onPrice((p) => this.onPrice(p)));
      }
    }
  }

  private async boot(now: Date): Promise<void> {
    const rows = await this.repo.loadArmed(this.acfg!.userIds);
    // The POSITION's exchange (NFO for a NIFTY option whose watch is NSE) — one PK query.
    const exchanges = await this.repo.trackerExchanges([...new Set(rows.map((r) => r.trackerId))]);
    for (const r of rows) {
      if (!r.instrument || !r.op || !r.price || !r.watchExchange || !r.watchToken || !r.armedAt) continue;
      const ref: InstrumentRef = { exchange: r.watchExchange as HubExchange, token: r.watchToken, symbol: r.watchSymbol ?? r.watchToken };
      this.book!.add({
        id: r.id, userId: r.userId, trackerId: r.trackerId, symbol: r.symbol, verdictId: r.verdictId,
        instrument: r.instrument as ArmedTrigger['instrument'], op: r.op as ArmedTrigger['op'], price: r.price,
        watch: { key: refKey(ref), exchange: ref.exchange, token: ref.token, symbol: ref.symbol },
        // A tracker that no longer exists keeps the watch exchange here; maintenance expires it as TRACKER_CLOSED.
        trackerExchange: exchanges.get(r.trackerId) ?? r.watchExchange,
        armedAt: r.armedAt.getTime(), confirm: EMPTY_CONFIRM,
      });
      const hub = this.hubs.get(r.userId);
      if (r.instrument === 'UNDERLYING' && hub) this.hold(ref, hub);
    }
    if (rows.length > 0) this.logger.warn(`[ai-trigger] rebuilt ${rows.length} armed trigger(s) from the table`);
    this.lastMaintenance = now.getTime();
    await this.maintain(now);
  }

  private async armPass(now: Date): Promise<void> {
    const since = new Date(now.getTime() - TRIGGER_TIMING.armLookbackMs);
    const rows = await this.repo.pendingProposals(this.acfg!.userIds, since, TRIGGER_TIMING.perPass);
    for (const row of rows) {
      try {
        await this.armOne(row, now);
      } catch (err) {
        this.logger.warn(`[ai-trigger] arming verdict ${row.id} failed: ${errText(err)} — retried next pass`);
      }
    }
  }

  private async armOne(row: ProposalRow, now: Date): Promise<void> {
    const stored = parseStoredTrigger(row.exitTrigger);
    if (stored.kind === 'problem') return this.reject(row, {}, `MALFORMED: ${stored.problem}`);
    const p = stored.trigger;
    const fields: TriggerFields = { instrument: p.instrument, op: p.op, price: p.price };

    const tracker = await this.repo.trackerFor(row.trackerId);
    if (!tracker || tracker.userId !== row.userId || tracker.status !== 'OPEN' || tracker.kind !== 'POSITION') {
      return this.reject(row, fields, 'TRACKER_NOT_OPEN');
    }
    const trackerExchange = String(tracker.exchange ?? '').toUpperCase();
    if (!AUTO_EXIT_EXCHANGES.includes(trackerExchange)) return this.reject(row, fields, 'EXCHANGE_NOT_FNO');

    const w = p.instrument === 'PREMIUM'
      ? { exchange: trackerExchange, token: String(tracker.token), symbol: tracker.symbol }
      : p.watch;
    const wex = String(w?.exchange ?? '').toUpperCase();
    if (!w || !w.token || !isHubExchange(wex)) return this.reject(row, fields, 'NO_WATCH_TARGET');
    const ref: InstrumentRef = { exchange: wex, token: String(w.token), symbol: w.symbol };
    const key = refKey(ref);
    const wfields: TriggerFields = { ...fields, watchExchange: ref.exchange, watchToken: ref.token, watchSymbol: ref.symbol };

    const hub = this.hubs.get(row.userId);
    if (!hub) return this.reject(row, wfields, 'NO_HUB');
    if (p.instrument === 'UNDERLYING') this.hold(ref, hub);

    const r = hub.price(ref, { maxAgeMs: TRIGGER_TIMING.armPriceMaxAgeMs });
    if (r.kind === 'market-closed') {
      this.deferred.delete(row.id);
      await this.reject(row, wfields, 'EXCHANGE_CLOSED');
      return this.releaseIfUnused(key);
    }
    if (r.kind !== 'fresh') {
      const first = this.deferred.get(row.id)?.firstSeen ?? now.getTime();
      if (now.getTime() - first < TRIGGER_TIMING.armDeferMs) {
        this.deferred.set(row.id, { firstSeen: first, key: p.instrument === 'UNDERLYING' ? key : null });
        return;
      }
      this.deferred.delete(row.id);
      const why = r.kind === 'stale' ? `stale ${Math.round(r.ageMs / 1000)} s` : r.reason;
      await this.reject(row, wfields, `NO_FRESH_PRICE (${why})`);
      return this.releaseIfUnused(key);
    }
    this.deferred.delete(row.id);

    const current = { price: r.price.ltp, ageMs: Math.max(0, now.getTime() - r.price.at) };
    const armed = this.book!.byTracker(row.trackerId);
    const v = validateTrigger({
      proposal: p, qty: Number(tracker.qty), kind: contractKindOf(tracker.symbol), current,
      armed: armed ? { instrument: armed.instrument, op: armed.op, price: armed.price } : null,
      cfg: this.tcfg!,
    });
    if (!v.ok) {
      await this.reject(row, { ...wfields, refPrice: current.price }, v.reason);
      return this.releaseIfUnused(key);
    }

    const res = await this.repo.arm(row, { ...wfields, refPrice: current.price } as Required<TriggerFields>, now);
    if (!res) {
      this.logger.warn(`[ai-trigger] arming verdict ${row.id} lost a race — retried next pass if still pending`);
      return this.releaseIfUnused(key);
    }
    const replaced = this.book!.add({
      id: res.id, userId: row.userId, trackerId: row.trackerId, symbol: row.symbol, verdictId: row.id,
      instrument: p.instrument, op: p.op, price: p.price,
      watch: { key, exchange: ref.exchange, token: ref.token, symbol: ref.symbol },
      trackerExchange, armedAt: now.getTime(), confirm: EMPTY_CONFIRM,
    });
    if (replaced && replaced.watch.key !== key) this.releaseIfUnused(replaced.watch.key);
    this.logger.warn(
      `[ai-trigger] ARMED auto-exit if ${ref.symbol} ${sign(p.op)} ${p.price} (now ${current.price}) — ` +
        `${row.symbol} verdict ${row.id}${res.superseded.length ? `; supersedes ${res.superseded.join(',')}` : ''}`,
    );
  }

  private async reject(row: ProposalRow, f: TriggerFields, reason: string): Promise<void> {
    const recorded = await this.repo.reject(row, f, reason);
    if (recorded) this.logger.log(`[ai-trigger] REJECTED ${reason} — ${row.symbol} verdict ${row.id}`);
  }

  private async fire(f: Fire): Promise<void> {
    const t = f.trigger;
    const acfg = this.acfg;
    if (!acfg) return;
    const now = new Date();
    let won: boolean;
    try {
      won = await this.repo.claimFire(t.id, { price: f.tick.price, at: new Date(f.tick.at) }, now);
    } catch (err) {
      // R8: never execute without a won claim. Re-arm in memory; a later cross retries.
      // Never over a newer trigger armed for the tracker while the claim was in flight.
      const newer = this.book?.byTracker(t.trackerId);
      this.logger.error(
        `[ai-trigger] fire claim failed for ${t.symbol} trigger ${t.id}: ${errText(err)} — ` +
          `${newer ? `superseded by ${newer.id} meanwhile, not re-armed` : 're-armed'}, nothing sent`,
      );
      if (!newer) this.book?.add({ ...t, confirm: EMPTY_CONFIRM });
      else this.releaseIfUnused(t.watch.key);
      return;
    }
    if (!won) {
      this.logger.warn(`[ai-trigger] trigger ${t.id} was no longer ARMED — nothing sent`);
      this.releaseIfUnused(t.watch.key);
      return;
    }
    const reason = firedReason(t, f.tick, IST_HM.format(t.armedAt));
    this.logger.warn(`[ai-trigger] FIRED ${reason}`);
    this.releaseIfUnused(t.watch.key);
    const v: PendingVerdict = {
      id: triggerVerdictId(t.id), userId: t.userId, trackerId: t.trackerId, symbol: t.symbol, reason, createdAt: now,
    };
    try {
      const id = await this.execRepo.claim(v, acfg.mode);
      if (!id) {
        this.logger.warn(`[ai-trigger] execution for trigger ${t.id} already claimed — nothing more sent`);
        return;
      }
      await this.executor.execute(id, v, acfg, now, 'PRICE_TRIGGER');
    } catch (err) {
      this.logger.error(`[ai-trigger] executor errored for trigger ${t.id}: ${errText(err)}`);
    }
  }

  private async maintain(now: Date): Promise<void> {
    const book = this.book!;
    const tcfg = this.tcfg!;
    const due = new Map<string, string[]>();
    const add = (reason: string, id: string) => due.set(reason, [...(due.get(reason) ?? []), id]);
    const rest: ArmedTrigger[] = [];
    for (const t of book.all()) {
      if (now.getTime() - t.armedAt > tcfg.maxAgeMin * 60_000) add('MAX_AGE', t.id);
      else if (!this.clock.isOpen(t.trackerExchange, now)) add('EXCHANGE_CLOSED', t.id);
      else rest.push(t);
    }
    const closed = new Set(await this.repo.closedTrackerIds([...new Set(rest.map((t) => t.trackerId))]));
    for (const t of rest) if (closed.has(t.trackerId)) add('TRACKER_CLOSED', t.id);
    for (const [reason, ids] of due) await this.expire(ids, reason, now);

    for (const t of book.all()) {
      const seen = book.lastSeen(t.watch.key) ?? t.armedAt;
      if (this.clock.isOpen(t.watch.exchange, now) && now.getTime() - seen > TRIGGER_TIMING.starvedMs) {
        this.warnOnce(`starved:${t.id}`, `[ai-trigger] STARVED: no price for ${t.watch.symbol} in ${Math.round((now.getTime() - seen) / 1000)} s — trigger ${t.id} cannot fire until prices return`);
      }
    }
  }

  /** Memory first (the safe direction), then the table. */
  private async expire(ids: string[], reason: string, now: Date): Promise<void> {
    const keys = new Set<string>();
    for (const id of ids) {
      const t = this.book?.remove(id);
      if (t) keys.add(t.watch.key);
    }
    for (const k of keys) this.releaseIfUnused(k);
    try {
      const n = await this.repo.expire(ids, reason, now);
      if (n > 0) this.logger.log(`[ai-trigger] EXPIRED ${n} trigger(s): ${reason}`);
    } catch (err) {
      this.logger.warn(`[ai-trigger] expiring ${ids.join(',')} failed: ${errText(err)} — already disarmed in memory`);
    }
  }

  private hold(ref: InstrumentRef, hub: HubPrices): void {
    const key = refKey(ref);
    if (this.held.has(key)) return;
    this.held.set(key, { ref, hub });
    void hub.watch([ref], 1, TRIGGER_WATCH_OWNER);
  }

  private releaseIfUnused(key: string): void {
    const h = this.held.get(key);
    if (!h) return;
    if (this.book?.hasKey(key)) return;
    for (const d of this.deferred.values()) if (d.key === key) return;
    this.held.delete(key);
    void h.hub.unwatch([h.ref], TRIGGER_WATCH_OWNER);
  }

  private warnOnce(key: string, line: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(line);
  }
}
