// apps/api/src/modules/sentinel-executor/services/exit-authority-router.service.ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CARRY_EXIT_STAMP } from '../../intraday-carry/intraday-carry.service';
import {
  FLOOR_HARD_EXIT_STAMP,
  TARGET_LADDER_STAMP,
  isPaperTrackerId,
  isRuleStamp,
  ruleAlarmFor as ruleAlarmForStamp,
} from '../domain/exit-authority';
import { CONFIRM_TIMEOUT_MS } from '../../exit-authority/domain/timings';
import { exitAnswer } from '../../exit-authority/domain/agent-verdict';
import { DRILL_SKIP_REASON, isDrillAlarm, isDrillReason } from '../../exit-authority/domain/drill';
import {
  AUTHORITY_STATE,
  OWNER_ESCALATION,
  SUPREME_CONFIRM,
  TRADE_ALARMS,
  TRADE_BRIEFS,
  type AlarmRow,
  type AlarmRule,
  type AlarmUrgency,
  type AuthorityStatePort,
  type ConfirmResult,
  type OwnerEscalationPort,
  type SupremeConfirmPort,
  type TradeAlarmsPort,
  type TradeBriefsPort,
} from '../../exit-authority/exit-authority.tokens';
import type { AutoExitConfig, AutoExitMode } from '../domain/auto-exit.types';
import { isHeld } from '../domain/guards';
import { AiExitExecutionRepository, type PendingVerdict } from '../repositories/ai-exit-execution.repository';
import { sendOpsAlert } from '../../../common/utils/ops-alert';

export type RouteOutcome =
  | { kind: 'EXECUTE' }
  | { kind: 'ALARM'; alarmId: string | null }
  | { kind: 'HELD_BY_SUPREME'; reason: string }
  /** An authority-drill verdict (exit-authority/domain/drill.ts): claimed SKIPPED DRILL, never executed. */
  | { kind: 'DRILL' };

/**
 * The code-rule verdict stamps (promptVersion of an EXIT_NOW no prompt wrote). CARRY is imported; the two
 * trade-sentinel stamps are a wire contract in domain/exit-authority.ts (plan R14 forbids importing trade-sentinel).
 * Detection itself is by the 'rule:' prefix, so a stamp missing here is still never sold by code under live.
 */
export const RULE_STAMPS: readonly string[] = [FLOOR_HARD_EXIT_STAMP, TARGET_LADDER_STAMP, CARRY_EXIT_STAMP];

/** ai_exit_executions.reason of a rule EXIT_NOW turned into an alarm (the poller never re-reads it). */
export const AUTHORITY_ALARM = 'AUTHORITY_ALARM';
/** Live with no alarm store bound: the rule exit is not sold (fail closed). */
export const AUTHORITY_NO_ALARM_STORE = 'AUTHORITY_NO_ALARM_STORE';
/** The alarm could not be stored RAISE_ATTEMPTS times: the row is closed so it stops blocking the poll. */
export const AUTHORITY_ALARM_RAISE_FAILED = 'AUTHORITY_ALARM_RAISE_FAILED';
export const RAISE_ATTEMPTS = 3;
/** ai_exit_executions.reason prefix of an agent EXIT the supreme overrode to HOLD. */
export const SUPREME_HOLD = 'SUPREME_HOLD';

const EXECUTE: RouteOutcome = { kind: 'EXECUTE' };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The alarm a code-rule EXIT_NOW becomes: rule from the stamp (MAX_LOSS on the floor stamp = hard loss). */
export const ruleAlarmFor = (promptVersion: string, reason: string): { rule: AlarmRule; urgency: AlarmUrgency } =>
  ruleAlarmForStamp(promptVersion, reason, CARRY_EXIT_STAMP);

/**
 * Trade agent exit authority (docs/superpowers/specs/2026-11-27-trade-agent-exit-authority-design.md §4.2–4.4),
 * between the 5-s EXIT_NOW poll and the executor. Inert unless AUTHORITY_STATE is bound and live:
 * then every verdict is EXECUTE, exactly as today.
 *
 * Live, for a LIVE tracker not on the owner hold list:
 * - a code-rule EXIT_NOW (promptVersion `rule:…`) never sells: it raises an alarm for the trade agent, and its
 *   execution row is written SKIPPED AUTHORITY_ALARM so the poller never reads it again;
 * - an agent (LLM) EXIT_NOW is confirmed by the supreme (30 s race): CONFIRM / TIMEOUT / ERROR → EXECUTE,
 *   OVERRIDE_HOLD → SKIPPED SUPREME_HOLD:<reason>. While a SUPREME_EXIT alarm is open the supreme asked for this
 *   exit, so it executes without a confirm call.
 */
@Injectable()
export class ExitAuthorityRouter {
  private readonly logger = new Logger(ExitAuthorityRouter.name);

  constructor(
    private readonly repo: AiExitExecutionRepository,
    @Optional() @Inject(AUTHORITY_STATE) private readonly state?: AuthorityStatePort,
    @Optional() @Inject(TRADE_ALARMS) private readonly alarms?: TradeAlarmsPort,
    @Optional() @Inject(SUPREME_CONFIRM) private readonly supreme?: SupremeConfirmPort,
    @Optional() @Inject(TRADE_BRIEFS) private readonly briefs?: TradeBriefsPort,
    @Optional() @Inject(OWNER_ESCALATION) private readonly escalation?: OwnerEscalationPort,
  ) {}

  /** verdictId → consecutive failed alarm raises (bounded). */
  private readonly raiseFailures = new Map<string, number>();

  /** True only when the exit authority is bound and live. False ⇒ callers keep today's path untouched. */
  active(): boolean {
    try {
      return this.state?.isLive() === true;
    } catch {
      return false;
    }
  }

  async route(v: PendingVerdict & { promptVersion?: string | null }, cfg?: Pick<AutoExitConfig, 'mode' | 'hold'>): Promise<RouteOutcome> {
    if (!this.active()) return EXECUTE;
    if (isPaperTrackerId(v.trackerId)) return EXECUTE;
    const mode: AutoExitMode = cfg?.mode ?? 'live';
    // Authority drill, belt and braces: the sentinel stores a drill look's EXIT_NOW as EXIT_ADVISORY (never polled);
    // a verdict that still carries the drill tag is claimed SKIPPED DRILL here and never reaches the executor.
    if (isDrillReason(v.reason)) return this.drillVerdict(v, mode);
    // The owner hold list is untouched, as today: the executor skips it OWNER_HOLD.
    if (cfg && isHeld(cfg.hold, { id: v.trackerId, symbol: v.symbol })) return EXECUTE;
    if (isRuleStamp(v.promptVersion)) return this.ruleAlarm(v, String(v.promptVersion), mode);
    return this.agentExit(v, mode);
  }

  private async ruleAlarm(v: PendingVerdict, stamp: string, mode: AutoExitMode): Promise<RouteOutcome> {
    const { rule, urgency } = ruleAlarmFor(stamp, String(v.reason ?? ''));
    if (!this.alarms) {
      // Fail CLOSED: live with no alarm store would otherwise be a code sell. Nothing is sold; the owner is told.
      this.logger.error(`[exit-authority] live but no alarm store bound — rule ${rule} exit NOT sold — ${v.symbol} verdict ${v.id}`);
      await this.skipRow(v, mode, AUTHORITY_NO_ALARM_STORE);
      this.tellOwner(v, `no-store:${v.id}`, `rule ${rule} would have exited ${v.symbol}, but no alarm store is bound — nothing sold, nobody alarmed. Check the position.`);
      return { kind: 'ALARM', alarmId: null };
    }
    if (rule === 'CARRY') {
      // The carry engine raised (or will raise) its own CARRY alarm WITH the broker deadline. A rule:intraday-carry
      // EXIT_NOW (the carry judge's own EXIT) must not replace it with a deadline-less urgent one: while a deadline
      // alarm is open it covers this exit. (A raise that does go through keeps an existing deadline: TradeAlarmsService.)
      const covering = (await this.openAlarms(v.trackerId)).find((a) => a.rule === 'CARRY' && a.deadline != null);
      if (covering) {
        await this.skipRow(v, mode, AUTHORITY_ALARM);
        this.logger.warn(`[exit-authority] CARRY exit covered by the open deadline alarm ${covering.id} — not re-raised — ${v.symbol} verdict ${v.id}`);
        return { kind: 'ALARM', alarmId: covering.id };
      }
    }
    let alarm: AlarmRow | null;
    try {
      alarm = await this.alarms.raise({
        userId: v.userId, trackerId: v.trackerId, symbol: v.symbol, rule, urgency,
        reason: String(v.reason ?? '').slice(0, 500),
        wouldHave: String(v.reason ?? '').slice(0, 500),
        sourceRef: v.id,
        payload: { stamp, verdictId: v.id },
      });
    } catch (err) {
      // Never sold by code. Retried on the next pass (not claimed) up to RAISE_ATTEMPTS, then claimed SKIPPED so a
      // stuck row stops head-of-line blocking newer verdicts in the poll's oldest-first LIMIT.
      const n = (this.raiseFailures.get(v.id) ?? 0) + 1;
      this.raiseFailures.set(v.id, n);
      if (this.raiseFailures.size > 1_000) this.raiseFailures.delete(this.raiseFailures.keys().next().value as string);
      this.logger.error(`[exit-authority] alarm ${rule} for ${v.symbol} verdict ${v.id} could not be raised (${n}/${RAISE_ATTEMPTS}): ${errText(err)}`);
      if (n === 1) {
        void sendOpsAlert(`authority-raise:${v.id}`, `GrW ALERT: rule ${rule} alarm for ${v.symbol} could not be stored (${errText(err).slice(0, 200)}). Nothing sold. Retrying.`).catch(() => undefined);
      }
      if (n >= RAISE_ATTEMPTS) {
        this.raiseFailures.delete(v.id);
        await this.skipRow(v, mode, AUTHORITY_ALARM_RAISE_FAILED);
        this.tellOwner(v, `raise-failed:${v.id}`, `rule ${rule} alarm for ${v.symbol} failed ${n} times (${errText(err).slice(0, 200)}) — nothing sold, the agent was NOT alarmed. Check the position.`);
      }
      return { kind: 'ALARM', alarmId: null };
    }
    this.raiseFailures.delete(v.id);
    await this.skipRow(v, mode, AUTHORITY_ALARM);
    this.logger.warn(`[exit-authority] ALARM ${rule} (${urgency}) instead of a code exit — ${v.symbol} verdict ${v.id}${alarm ? ` alarm ${alarm.id}` : ' (an open alarm covers it)'}`);
    return { kind: 'ALARM', alarmId: alarm?.id ?? null };
  }

  /** Ops alert (deduped per key by sendOpsAlert) + the owner's blocked-exit escalation when bound. Never throws. */
  private tellOwner(v: PendingVerdict, key: string, text: string): void {
    void sendOpsAlert(`authority-${key}`, `GrW ALERT: ${text}`).catch(() => undefined);
    const esc = this.escalation;
    if (!esc) return;
    void Promise.resolve()
      .then(() => esc.blockedExit({ userId: v.userId, trackerId: v.trackerId, symbol: v.symbol, reason: String(v.reason ?? '').slice(0, 500), detail: text.slice(0, 500) }))
      .catch((err) => this.logger.warn(`[exit-authority] owner escalation for ${v.symbol} failed: ${errText(err)}`));
  }

  private async drillVerdict(v: PendingVerdict, mode: AutoExitMode): Promise<RouteOutcome> {
    await this.skipRow(v, mode, DRILL_SKIP_REASON);
    this.logger.warn(`[exit-authority] DRILL verdict ${v.id} on ${v.symbol} — observe only, NOT executed`);
    void sendOpsAlert(`authority-drill:${v.id}`, `GrW DRILL: ${v.symbol} drill verdict ${v.id} reached the exit router and was NOT executed (observe only).`).catch(() => undefined);
    return { kind: 'DRILL' };
  }

  private async agentExit(v: PendingVerdict, mode: AutoExitMode): Promise<RouteOutcome> {
    // A drill alarm (domain/drill.ts) never steers a real exit: not the supreme's request, not the confirm's context,
    // never answered here (the escalation runner answers it from the agent's verdict, observe-only).
    const open = (await this.openAlarms(v.trackerId)).filter((a) => !isDrillAlarm(a));
    const asked = open.find((a) => a.rule === 'SUPREME_EXIT');
    if (asked) {
      this.logger.warn(`[exit-authority] agent EXIT on the supreme's own request (alarm ${asked.id}) — executing, no confirm — ${v.symbol} verdict ${v.id}`);
      // Stored as the verdict word EXIT_NOW (exit-authority/domain/agent-verdict.ts): the escalation runner reads it as the
      // agent AGREEING with the supreme (isExitAnswer) and follows this exit, never a disagreement round trip.
      await this.answerAll(open, v.id, exitAnswer('supreme asked'));
      return EXECUTE;
    }
    if (!this.supreme) return EXECUTE;

    const brief = await this.briefFor(v.trackerId);
    const alarm = pickAlarm(open);
    const res = await this.confirm(v, alarm, brief);
    this.logger.warn(`[exit-authority] supreme confirm ${res.decision} in ${res.latencyMs} ms — ${v.symbol} verdict ${v.id}: ${res.reason}`);

    if (res.decision !== 'OVERRIDE_HOLD') {
      await this.answerAll(open, v.id, exitAnswer(`supreme ${res.decision}`));
      return EXECUTE;
    }
    const why = String(res.reason ?? '').slice(0, 300);
    await this.skipRow(v, mode, `${SUPREME_HOLD}:${why}`);
    await this.answerAll(open, v.id, `HOLD (supreme override): ${why}`);
    if (res.briefNote && this.briefs) {
      try {
        await this.briefs.write(v.trackerId, v.userId, res.briefNote, 'CONFIRM');
      } catch (err) {
        this.logger.warn(`[exit-authority] brief note for ${v.symbol} not written: ${errText(err)}`);
      }
    }
    return { kind: 'HELD_BY_SUPREME', reason: why };
  }

  /** The supreme's answer, raced against CONFIRM_TIMEOUT_MS. Never throws: a throw is ERROR, silence is TIMEOUT. */
  private async confirm(v: PendingVerdict & { promptVersion?: string | null }, alarm: AlarmRow | null, brief: string | null): Promise<ConfirmResult> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ConfirmResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ decision: 'TIMEOUT', reason: `no answer in ${CONFIRM_TIMEOUT_MS} ms — the agent's EXIT stands`, latencyMs: Date.now() - started }),
        CONFIRM_TIMEOUT_MS,
      );
    });
    const call = Promise.resolve()
      .then(() => this.supreme!.confirm({
        userId: v.userId, trackerId: v.trackerId, symbol: v.symbol, agentDecision: 'EXIT',
        agentReason: String(v.reason ?? ''), alarm, brief, packetSummary: packetSummary(v, alarm),
      }))
      .then((r): ConfirmResult => (r && typeof r.decision === 'string'
        ? r
        : { decision: 'ERROR', reason: 'empty confirm answer', latencyMs: Date.now() - started }))
      .catch((err): ConfirmResult => ({ decision: 'ERROR', reason: errText(err).slice(0, 300), latencyMs: Date.now() - started }));
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Claim the verdict's execution row and end it SKIPPED, so the poller never reads it again. */
  private async skipRow(v: PendingVerdict, mode: AutoExitMode, reason: string): Promise<void> {
    const id = await this.repo.claim(v, mode);
    if (!id) return; // already claimed elsewhere
    await this.repo.update(id, { status: 'SKIPPED', reason });
  }

  private async openAlarms(trackerId: string): Promise<AlarmRow[]> {
    if (!this.alarms) return [];
    try {
      return await this.alarms.openFor(trackerId);
    } catch (err) {
      this.logger.warn(`[exit-authority] open alarms of ${trackerId} unreadable: ${errText(err)}`);
      return [];
    }
  }

  private async briefFor(trackerId: string): Promise<string | null> {
    if (!this.briefs) return null;
    try {
      return await this.briefs.briefFor(trackerId);
    } catch {
      return null;
    }
  }

  private async answerAll(open: AlarmRow[], verdictId: string, answer: string): Promise<void> {
    if (!this.alarms) return;
    for (const a of open) {
      try {
        await this.alarms.answer(a.id, verdictId, answer);
      } catch (err) {
        this.logger.warn(`[exit-authority] alarm ${a.id} not answered: ${errText(err)}`);
      }
    }
  }
}

/** The open alarm the confirm call is about: urgent first, then the newest. */
function pickAlarm(open: AlarmRow[]): AlarmRow | null {
  if (open.length === 0) return null;
  const rank = (a: AlarmRow) => (a.urgency === 'urgent' ? 0 : a.urgency === 'deadline' ? 1 : 2);
  return [...open].sort((a, b) => rank(a) - rank(b) || new Date(b.lastRaisedAt).getTime() - new Date(a.lastRaisedAt).getTime())[0];
}

function packetSummary(v: PendingVerdict & { promptVersion?: string | null }, alarm: AlarmRow | null): string {
  const at = v.createdAt instanceof Date ? v.createdAt.toISOString() : String(v.createdAt);
  const parts = [`${v.symbol} (tracker ${v.trackerId}): trade agent EXIT_NOW at ${at} (prompt ${v.promptVersion ?? '?'})`];
  if (alarm) parts.push(`open alarm ${alarm.rule} (${alarm.urgency}): ${alarm.reason}`);
  return parts.join('; ').slice(0, 1000);
}
