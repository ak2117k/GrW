import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { isAnyVenueOpen, istYmd, liveSessionClock } from '../../trade-sentinel/overnight/overnight-calendar';
import { DESK_MANAGER_CONFIG, type DeskManagerConfig } from '../desk-manager.config';
import { DESK_ACTIONS, type ActionResult, type DeskActionsPort, type DeskPacket, type DeskWakePort, type ManagerDecision, type WakeReason } from '../domain/desk.types';
import { validateDecision } from '../domain/decision-validate';
import { parseManagerReply } from '../domain/manager-schema';
import { DeskManagerRepository } from '../repositories/desk-manager.repository';
import { ManagerLlmService } from './manager-llm.service';

/** What the manager sees (Task 3 binds DeskStateService + DeskStateRepository.busy behind it in Task 8). */
export const DESK_PACKET_BUILDER = Symbol('DESK_PACKET_BUILDER');
export interface DeskPacketBuilder {
  build(userId: string, now: Date, cfg: DeskManagerConfig): Promise<DeskPacket>;
  /** A position is open or a proposal is < 30 min old → the 3-min cadence. */
  busy(userId: string, now: Date): Promise<boolean>;
}

/** The runner's own tick (no fixed-hour cron: the venue clock decides). */
export const RUNNER_TICK_MS = 30_000;
/** Health: no completed run for idleEveryMin + this while a venue is open → alert + manager OPENs blocked. */
export const SILENCE_GRACE_MIN = 5;
/** WATCH re-check bounds (minutes). */
const WATCH_MIN = 1;
const WATCH_MAX = 60;

/** Acting order: protect first (EXIT / BOOK / TIGHTEN), then PAUSE / RESUME, then OPEN, then the record-only ones. */
const ORDER: Record<ManagerDecision['action'], number> = { EXIT: 0, BOOK: 0, TIGHTEN: 0, PAUSE_ENTRIES: 1, RESUME: 1, OPEN: 2, WATCH: 3, FLAG_DATA_HOLE: 3, NO_ACTION: 3 };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const istMidnight = (now: Date) => new Date(Date.parse(`${istYmd(now)}T00:00:00.000+05:30`));

interface RunState {
  abandoned: boolean;
  runId: string | null;
}

/**
 * The manager loop (plan Task 4, spec §5.1 / §5.3 / "AI budget").
 *
 * - 30 s tick; a run is due when the mode is not off, a venue is open, and 3 min (busy) / 10 min (idle) have
 *   passed since the last run, or a wake is pending for 20 s (debounce).
 * - Single-flight; a run longer than 150 s is abandoned (recorded, and its decisions are never acted on).
 * - ≤ maxCalls AI calls per IST day; at the cap it stops running (ops alert once a day) and blocks manager OPENs.
 * - No completed run for idleEveryMin + 5 min while a venue is open → ops alert `desk-manager-silent` and
 *   manager OPENs blocked until a run completes.
 * - Each run: packet → AI → parse (malformed = error recorded, nothing acted on) → validate each decision →
 *   store VALID / INVALID → execute the valid ones in ORDER → store each result.
 */
@Injectable()
export class ManagerRunnerService implements DeskWakePort, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ManagerRunnerService.name);

  /** Overridable in tests. */
  venueOpen: (now: Date) => boolean = (now) => isAnyVenueOpen(liveSessionClock(), now);
  alert: (key: string, text: string) => Promise<unknown> = (key, text) => sendOpsAlert(key, text);

  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastRunAt: Date | null = null;
  private lastCompleted: Date | null = null;
  private openBlocked = false;
  private venueOpenSince: Date | null = null;
  private readonly pending = new Set<WakeReason>();
  private firstWakeAt: Date | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private readonly watchTimers = new Map<string, NodeJS.Timeout>();
  private callDay: string | null = null;
  private callsToday = 0;
  private capAlertDay: string | null = null;
  private ownerWarned = false;

  constructor(
    @Inject(DESK_MANAGER_CONFIG) private readonly cfg: DeskManagerConfig,
    @Inject(DESK_PACKET_BUILDER) private readonly builder: DeskPacketBuilder,
    @Inject(DESK_ACTIONS) private readonly actions: DeskActionsPort,
    private readonly llm: ManagerLlmService,
    private readonly repo: DeskManagerRepository,
  ) {}

  onModuleInit(): void {
    if (this.cfg.mode === 'off') return;
    this.timer = setInterval(() => void this.tick(new Date()).catch((e) => this.log.warn(`tick failed: ${errText(e)}`)), RUNNER_TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    for (const t of this.watchTimers.values()) clearTimeout(t);
    this.timer = this.wakeTimer = null;
    this.watchTimers.clear();
  }

  /** Task 5 reads it: manager OPENs are refused while the manager is silent or at its AI call cap. */
  opensBlocked(): boolean {
    return this.openBlocked;
  }

  lastCompletedAt(): Date | null {
    return this.lastCompleted;
  }

  /** Ask for an early run; reasons collected for 20 s become ONE run. */
  wake(reason: WakeReason, now: Date = new Date()): void {
    if (this.cfg.mode === 'off') return;
    this.pending.add(reason);
    if (this.firstWakeAt) return;
    this.firstWakeAt = now;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.tick(new Date(now.getTime() + this.cfg.debounceMs)).catch((e) => this.log.warn(`wake tick failed: ${errText(e)}`));
    }, this.cfg.debounceMs);
    this.wakeTimer.unref?.();
  }

  /** One scheduler step: decides whether a run is due and starts it. */
  async tick(now: Date): Promise<void> {
    if (this.cfg.mode === 'off') return;
    const owner = this.cfg.ownerUserId;
    if (!owner) {
      if (!this.ownerWarned) this.log.warn('DESK_MANAGER is on but HUB_OWNER_USER_ID is not set: the manager does not run');
      this.ownerWarned = true;
      return;
    }
    if (!this.venueOpen(now)) {
      this.venueOpenSince = null;
      return;
    }
    this.venueOpenSince ??= now;

    await this.loadCallCount(owner, now);
    if (this.capped()) {
      this.openBlocked = true;
      const day = istYmd(now);
      if (this.capAlertDay !== day) {
        this.capAlertDay = day;
        void this.alert('desk-manager-call-cap', `Desk manager reached ${this.cfg.maxCalls} AI calls today (${day}); it stops running and opening until tomorrow. Exits by code rules continue.`);
      }
      return;
    }
    this.checkSilence(now);
    if (this.inFlight) return;

    const wakeDue = this.firstWakeAt !== null && now.getTime() - this.firstWakeAt.getTime() >= this.cfg.debounceMs;
    let due = wakeDue;
    if (!due) {
      const since = this.lastRunAt ? now.getTime() - this.lastRunAt.getTime() : Infinity;
      if (since >= this.cfg.idleEveryMin * 60_000) due = true;
      else if (since >= this.cfg.busyEveryMin * 60_000) due = await this.builder.busy(owner, now).catch(() => true);
    }
    if (!due) return;
    const reasons: WakeReason[] = this.pending.size ? [...this.pending] : ['cadence'];
    this.pending.clear();
    this.firstWakeAt = null;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    await this.runOnce(reasons, now);
  }

  /** One manager run (single-flight). null = not run (mode off, no owner, or a run in flight). */
  async runOnce(reasons: WakeReason[], now: Date): Promise<{ runId: string; decisions: number } | null> {
    const owner = this.cfg.ownerUserId;
    if (this.cfg.mode === 'off' || !owner || this.inFlight) return null;
    this.inFlight = true;
    this.lastRunAt = now;
    const state: RunState = { abandoned: false, runId: null };
    const startedReal = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'abandoned'>((resolve) => {
      timer = setTimeout(() => resolve('abandoned'), this.cfg.runTimeoutMs);
    });
    try {
      const out = await Promise.race([this.doRun(owner, reasons, now, state, startedReal), deadline]);
      if (out !== 'abandoned') return out;
      state.abandoned = true;
      this.log.warn(`desk manager run abandoned after ${this.cfg.runTimeoutMs} ms`);
      if (!state.runId) return null;
      await this.repo
        .finishRun(state.runId, { finishedAt: this.at(now, startedReal), error: `abandoned after ${this.cfg.runTimeoutMs} ms: nothing acted on` })
        .catch((e) => this.log.warn(`finishRun failed: ${errText(e)}`));
      return { runId: state.runId, decisions: 0 };
    } finally {
      clearTimeout(timer);
      this.inFlight = false;
    }
  }

  private async doRun(owner: string, reasons: WakeReason[], now: Date, state: RunState, startedReal: number): Promise<{ runId: string; decisions: number }> {
    const runId = await this.repo.createRun({ userId: owner, startedAt: now, wakeReasons: reasons, mode: this.cfg.mode });
    state.runId = runId;
    const finish = (f: Parameters<DeskManagerRepository['finishRun']>[1]) => (state.abandoned ? Promise.resolve() : this.repo.finishRun(runId, f));

    const p0 = Date.now();
    let packet: DeskPacket;
    try {
      packet = await this.builder.build(owner, now, this.cfg);
    } catch (e) {
      await finish({ finishedAt: this.at(now, startedReal), packetMs: Date.now() - p0, error: `packet: ${errText(e)}` });
      return { runId, decisions: 0 };
    }
    const packetMs = Date.now() - p0;
    if (state.abandoned) return { runId, decisions: 0 };

    this.callsToday++;
    const a0 = Date.now();
    let text: string;
    let aiMs: number;
    try {
      const r = await this.llm.decide(owner, packet);
      text = r.text;
      aiMs = r.ms;
    } catch (e) {
      await finish({ finishedAt: this.at(now, startedReal), packet, packetMs, aiMs: Date.now() - a0, error: `ai: ${errText(e)}` });
      return { runId, decisions: 0 };
    }
    if (state.abandoned) return { runId, decisions: 0 };

    const parsed = parseManagerReply(text);
    if (!parsed.ok) {
      await finish({ finishedAt: this.at(now, startedReal), packet, packetMs, aiMs, reply: { raw: text.slice(0, 20_000) }, error: `reply: ${parsed.error}` });
      return { runId, decisions: 0 };
    }

    const rows: Array<{ id: string; d: ManagerDecision; valid: boolean }> = [];
    for (const d of parsed.reply.decisions) {
      const problems = validateDecision(d, packet);
      const id = await this.repo.insertDecision({ runId, userId: owner, decision: d, problems });
      rows.push({ id, d, valid: problems.length === 0 });
    }
    const ordered = rows.filter((r) => r.valid).sort((a, b) => ORDER[a.d.action] - ORDER[b.d.action]);
    for (const r of ordered) {
      if (state.abandoned) break;
      let result: ActionResult;
      try {
        result = await this.actions.execute(r.d, { runId, decisionId: r.id, now, packet, cfg: this.cfg });
      } catch (e) {
        result = { status: 'FAILED', detail: errText(e) };
      }
      await this.repo.setDecisionResult(r.id, { result, ...this.refsOf(r.d, result) }).catch((e) => this.log.warn(`setDecisionResult failed: ${errText(e)}`));
      if (r.d.action === 'WATCH' && result.status !== 'REFUSED' && result.status !== 'FAILED') this.scheduleWatch(r.d.underlying, r.d.recheckMin);
    }
    if (state.abandoned) return { runId, decisions: 0 };

    const finishedAt = this.at(now, startedReal);
    await finish({ finishedAt, packet, packetMs, aiMs, reply: parsed.reply, summary: parsed.reply.summary });
    this.lastCompleted = finishedAt;
    this.openBlocked = this.capped();
    return { runId, decisions: parsed.reply.decisions.length };
  }

  /** Where an action's ref is stored: live OPEN → signal_orders row, shadow OPEN → trades row, EXIT/BOOK → ai_exit_executions. */
  private refsOf(d: ManagerDecision, r: ActionResult): { orderRowId?: string; tradeId?: string; execId?: string } {
    if (!r.ref) return {};
    if (d.action === 'OPEN') return this.cfg.mode === 'live' ? { orderRowId: r.ref } : { tradeId: r.ref };
    if (d.action === 'EXIT' || d.action === 'BOOK') return { execId: r.ref };
    return {};
  }

  private scheduleWatch(underlying: string, recheckMin: number): void {
    const min = Math.min(WATCH_MAX, Math.max(WATCH_MIN, Math.round(recheckMin)));
    const prev = this.watchTimers.get(underlying);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.watchTimers.delete(underlying);
      this.wake('watch_recheck');
    }, min * 60_000);
    t.unref?.();
    this.watchTimers.set(underlying, t);
  }

  private checkSilence(now: Date): void {
    const since = Math.max(this.lastCompleted?.getTime() ?? 0, this.venueOpenSince?.getTime() ?? now.getTime());
    const silentMin = (now.getTime() - since) / 60_000;
    if (silentMin < this.cfg.idleEveryMin + SILENCE_GRACE_MIN) return;
    if (!this.openBlocked) this.log.warn(`desk manager silent for ${Math.round(silentMin)} min: manager OPENs blocked`);
    this.openBlocked = true;
    void this.alert(
      'desk-manager-silent',
      `Desk manager has not completed a run for ${Math.round(silentMin)} min while a venue is open (last completed ${this.lastCompleted?.toISOString() ?? 'never'}). Manager OPENs are blocked until it completes one.`,
    );
  }

  private capped(): boolean {
    return this.callsToday >= this.cfg.maxCalls;
  }

  /** The day's call count, from the table on the first tick of an IST day (survives a restart). */
  private async loadCallCount(owner: string, now: Date): Promise<void> {
    const day = istYmd(now);
    if (this.callDay === day) return;
    this.callDay = day;
    this.callsToday = await this.repo.countAiCallsSince(owner, istMidnight(now)).catch(() => 0);
  }

  /** `now` advanced by the real time the run took (tests inject `now`). */
  private at(now: Date, startedReal: number): Date {
    return new Date(now.getTime() + (Date.now() - startedReal));
  }
}
