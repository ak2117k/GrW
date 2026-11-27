import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { AI_HEALTH, type AiHealthPort } from '../../ai-gateway/audit/failover-transport';
import { backstopDue, escalationDue, isSnoozed } from '../domain/alarm';
import { REALERT_EVERY_MS, SUPREME_EXIT_AGENT_LOOK_MS } from '../domain/timings';
import {
  SUPREME_CONFIRM,
  TRADE_ALARMS,
  TRADE_BRIEFS,
  type AlarmRow,
  type ConfirmResult,
  type SupremeConfirmPort,
  type TradeAlarmsPort,
  type TradeBriefsPort,
} from '../exit-authority.tokens';
import { EscalationRepository } from '../repositories/escalation.repository';
import { TradeAlarmRepository } from '../repositories/trade-alarm.repository';
import { TelegramBotClient, type InlineButton } from '../telegram/telegram-bot.client';
import { AuthorityStateService } from './authority-state.service';

/**
 * Ports this task consumes and Task 7 binds (all @Optional):
 * - HARD_LOSS_PROBE: is the trade still past today's hard-loss limit? Absent ⇒ never (the hard-loss backstop
 *   cannot fire without a fresh reading; the DEADLINE backstop still can).
 * - OWNER_EXIT: the owner path (ManualExitService.request as the alarm's owner). Absent ⇒ nothing can be
 *   sold from here: logged as ERROR and told to the owner on Telegram, never silent.
 */
export const HARD_LOSS_PROBE = Symbol('HARD_LOSS_PROBE');
export interface HardLossProbe {
  stillPastLimit(trackerId: string): Promise<boolean>;
}

export const OWNER_EXIT = Symbol('OWNER_EXIT');
export interface OwnerExitPort {
  /** Places the owner-path exit; resolves a short result (e.g. the attempt id). Throws when refused. */
  exitAsOwner(userId: string, trackerId: string, reason: string): Promise<string>;
}

export const ESCALATION_PASS_MS = 15_000;
/** "Cannot act" Telegram lines repeat at most this often per alarm (the ERROR log is every pass). */
const CANNOT_ACT_REPEAT_MS = 300_000;
const HARD_LOSS_RULES = new Set(['HARD_LOSS', 'HARD_LOSS_FAST']);
/** A sentinel verdict that is an exit (the agent agrees with a supreme exit request). */
const isExitVerdict = (v: string): boolean => /^EXIT_NOW\b/i.test(v.trim());
const LOG = '[exit-authority]';

export const alarmButtons = (alarmId: string): InlineButton[][] => [
  [
    { text: 'Exit', data: `x:${alarmId}` },
    { text: 'Hold', data: `h:${alarmId}` },
  ],
];

export function istTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Owner escalation and the two backstop exits (design §4.4, §4.5 B, §4.5a). One pass every 15 s, only in the
 * boot-jobs container and only while the authority is live. Every decision is read from trade_alarms /
 * sentinel_verdicts / trade_trackers, so a restarted process (a fresh runner) resumes exactly where it was.
 *
 * Per alarm, in order:
 *  - its tracker is no longer OPEN → CLOSED;
 *  - SUPREME_EXIT → the round trip (agent silent ≥60 s → exit; agent disagrees → one supreme confirm);
 *  - an LLM verdict since it was raised → answered;
 *  - a backstop due (DEADLINE, or HARD_LOSS with everyone unreachable) → owner-path exit, BACKSTOPPED;
 *  - otherwise the owner is alerted (new message) / re-alerted (the same message edited).
 */
@Injectable()
export class EscalationRunner {
  private readonly log = new Logger(EscalationRunner.name);
  private running = false;
  private readonly cannotActAt = new Map<string, number>();
  private warnedNoProbe = false;

  constructor(
    private readonly alarmRepo: TradeAlarmRepository,
    private readonly esc: EscalationRepository,
    @Inject(TRADE_ALARMS) private readonly alarms: TradeAlarmsPort,
    private readonly state: AuthorityStateService,
    private readonly telegram: TelegramBotClient,
    @Optional() @Inject(OWNER_EXIT) private readonly ownerExit?: OwnerExitPort,
    @Optional() @Inject(HARD_LOSS_PROBE) private readonly probe?: HardLossProbe,
    @Optional() @Inject(AI_HEALTH) private readonly aiHealth?: AiHealthPort,
    @Optional() @Inject(SUPREME_CONFIRM) private readonly supreme?: SupremeConfirmPort,
    @Optional() @Inject(TRADE_BRIEFS) private readonly briefs?: TradeBriefsPort,
  ) {}

  @Interval(ESCALATION_PASS_MS)
  async tick(): Promise<void> {
    if (!bootJobsEnabled() || !this.state.isLive()) return;
    await this.pass(new Date());
  }

  async pass(now: Date): Promise<void> {
    if (this.running) return; // a supreme confirm can take 30 s: never overlap passes
    this.running = true;
    try {
      const all = await this.esc.findForRunner();
      if (all.length === 0) return;
      const open = await this.esc.openTrackerIds([...new Set(all.map((a) => a.trackerId))]);
      const aiDown = this.aiDown();
      for (const a of all) {
        try {
          if (!open.has(a.trackerId)) await this.closeGone(a);
          else if (a.rule === 'SUPREME_EXIT') await this.supremeExit(a, now);
          else if (a.status !== 'ANSWERED') await this.openAlarm(a, now, aiDown);
        } catch (err) {
          this.log.error(`${LOG} escalation pass failed on alarm ${a.id} (${a.symbol} ${a.rule}): ${(err as Error)?.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  // ── per-alarm steps ──────────────────────────────────────────────────────

  private async closeGone(a: AlarmRow): Promise<void> {
    await this.alarmRepo.update(a.id, { status: 'CLOSED' });
    this.log.log(`${LOG} alarm ${a.id} ${a.symbol} ${a.rule} CLOSED: tracker ${a.trackerId} is no longer open`);
    if (a.telegramMessageId != null) {
      await this.edit(a.telegramMessageId, `${a.symbol}: trade closed. Alarm ${a.rule} closed, nothing to do.`);
    }
  }

  private async openAlarm(a: AlarmRow, now: Date, aiDown: boolean): Promise<void> {
    // Resolve: the agent has looked since the alarm was raised.
    if (a.answeredAt == null) {
      const v = await this.alarmRepo.latestAgentVerdict(a.trackerId, a.raisedAt);
      if (v) {
        await this.alarms.answer(a.id, v.id, v.verdict, now);
        if (a.telegramMessageId != null) {
          await this.edit(a.telegramMessageId, `${a.symbol}: the agent answered ${v.verdict} at ${istTime(v.createdAt)} IST. Alarm ${a.rule} resolved.`);
        }
        return;
      }
    }

    // Backstop (the only two code sells). Probe the hard loss only when everything else already says due.
    const pre = backstopDue(a, { aiDown, stillPastLimit: true }, now);
    if (pre === 'DEADLINE') return this.backstop(a, 'DEADLINE', now);
    if (pre === 'HARD_LOSS' && (await this.stillPastLimit(a))) return this.backstop(a, 'HARD_LOSS', now);

    // Escalate to the owner.
    let due = escalationDue(a, now);
    if (due == null && aiDown && a.alertedAt == null && a.answeredAt == null && !isSnoozed(a, now)) {
      due = 'ALERT'; // §4.5 B: every AI route is down while this alarm waits on a look
    }
    if (due === 'REALERT' && a.alertedAt != null && now.getTime() - a.alertedAt.getTime() < Math.max(1, a.alertCount) * REALERT_EVERY_MS) {
      due = null; // alertedAt is the FIRST alert (the backstop's owner-silent clock): repeat every 5 min from it
    }
    if (due == null) return;

    if (due === 'REALERT') {
      const count = a.alertCount + 1;
      const text = await this.alertText(a, now, `REPEAT ${count - 1}: ALARM UNANSWERED`, aiDown);
      let messageId = a.telegramMessageId;
      if (messageId != null) {
        const ok = await this.edit(messageId, text, alarmButtons(a.id));
        if (!ok) messageId = null;
      }
      if (messageId == null) messageId = await this.send(text, alarmButtons(a.id));
      await this.alarmRepo.update(a.id, { alertCount: count, telegramMessageId: messageId });
      return;
    }

    const header = due === 'DEADLINE_WARN' ? 'DEADLINE WARNING: NO AGENT DECISION' : 'ALARM UNANSWERED';
    const messageId = await this.send(await this.alertText(a, now, header, aiDown), alarmButtons(a.id));
    // alertedAt is recorded even when the send failed: the owner was unreachable, which is exactly what the
    // hard-loss backstop's owner-silent clock measures.
    await this.alarmRepo.update(a.id, { alertedAt: now, alertCount: 1, telegramMessageId: messageId });
  }

  private async backstop(a: AlarmRow, kind: 'DEADLINE' | 'HARD_LOSS', now: Date): Promise<void> {
    const reason = `BACKSTOP ${kind}: ${a.symbol} ${a.rule}: ${a.reason}`.slice(0, 480);
    if (!this.ownerExit) return this.cannotAct(a, `backstop ${kind}`, now);
    let result: string;
    try {
      result = await this.ownerExit.exitAsOwner(a.userId, a.trackerId, reason);
    } catch (err) {
      const msg = (err as Error)?.message ?? 'error';
      this.log.error(`${LOG} backstop ${kind} exit FAILED on ${a.symbol} (${a.trackerId}): ${msg}`);
      await this.throttledNotify(a, now, `BACKSTOP ${kind} exit FAILED on ${a.symbol}: ${msg}. Exit it yourself. Retrying every 15 s.`);
      return;
    }
    await this.alarmRepo.update(a.id, { status: 'BACKSTOPPED' });
    this.log.warn(`${LOG} ${reason} → exit sent (${result})`);
    const line = `BACKSTOP ${kind}: code sold ${a.symbol} (${result}).\nAlarm ${a.rule}: ${a.reason}\nNo agent decision${kind === 'HARD_LOSS' ? ', no owner answer for 10 min, and still past the hard-loss limit' : ' before the broker deadline'}.`;
    if (a.telegramMessageId != null) await this.edit(a.telegramMessageId, line);
    await this.send(line);
  }

  /** §4.4: the agent gets one look at a supreme exit request; a non-exit answer goes back to the supreme once. */
  private async supremeExit(a: AlarmRow, now: Date): Promise<void> {
    if (a.payload?.roundTrip === true) return;

    let verdict: { id: string; verdict: string } | null =
      a.answeredAt != null && a.answer != null ? { id: a.answerVerdictId ?? '', verdict: a.answer } : null;
    if (!verdict) {
      const v = await this.alarmRepo.latestAgentVerdict(a.trackerId, a.raisedAt);
      if (v) {
        await this.alarms.answer(a.id, v.id, v.verdict, now);
        verdict = { id: v.id, verdict: v.verdict };
      }
    }

    if (!verdict) {
      if (now.getTime() - a.raisedAt.getTime() < SUPREME_EXIT_AGENT_LOOK_MS) return;
      if (!this.ownerExit) return this.cannotAct(a, 'SUPREME_EXIT (agent silent)', now);
      await this.markRoundTrip(a, { agent: 'silent' });
      await this.supremeExitNow(a, `SUPREME_EXIT (agent silent): ${a.reason}`, now);
      return;
    }

    if (isExitVerdict(verdict.verdict)) {
      // The agent agrees: its own EXIT goes through the executor (and the supreme confirm) as usual.
      await this.markRoundTrip(a, { agent: verdict.verdict });
      return;
    }

    if (!this.ownerExit) return this.cannotAct(a, 'SUPREME_EXIT (final)', now);
    // Marked BEFORE the call so the confirm is made exactly once per alarm, across passes and restarts.
    await this.markRoundTrip(a, { agent: verdict.verdict });
    const result = await this.confirmOnce(a, verdict);
    this.log.warn(`${LOG} SUPREME_EXIT ${a.symbol}: agent ${verdict.verdict} → supreme ${result.decision} (${result.reason})`);
    await this.markRoundTrip(a, { agent: verdict.verdict, supreme: result.decision });
    if (result.decision === 'OVERRIDE_HOLD') return;
    await this.supremeExitNow(a, `SUPREME_EXIT (final): ${a.reason}`, now);
  }

  private async confirmOnce(a: AlarmRow, verdict: { id: string; verdict: string }): Promise<ConfirmResult> {
    if (!this.supreme) return { decision: 'ERROR', reason: 'SUPREME_CONFIRM not bound: the supreme exit stands', latencyMs: 0 };
    let brief: string | null = null;
    try {
      brief = (await this.briefs?.briefFor(a.trackerId)) ?? null;
    } catch {
      brief = null;
    }
    try {
      return await this.supreme.confirm({
        userId: a.userId,
        trackerId: a.trackerId,
        symbol: a.symbol,
        agentDecision: 'EXIT',
        agentReason: `the trade agent answered ${verdict.verdict} (verdict ${verdict.id}) to the supreme's exit request`,
        alarm: a,
        brief,
        packetSummary: `Supreme asked EXIT: ${a.reason}. The trade agent disagrees (${verdict.verdict}). Confirm the exit or hold.`,
        agentDisagrees: true,
      });
    } catch (err) {
      return { decision: 'ERROR', reason: (err as Error)?.message ?? 'confirm threw', latencyMs: 0 };
    }
  }

  private async supremeExitNow(a: AlarmRow, reason: string, now: Date): Promise<void> {
    try {
      const result = await this.ownerExit!.exitAsOwner(a.userId, a.trackerId, reason.slice(0, 480));
      await this.alarmRepo.update(a.id, { status: 'CLOSED' });
      this.log.warn(`${LOG} ${reason} → exit sent on ${a.symbol} (${result})`);
    } catch (err) {
      const msg = (err as Error)?.message ?? 'error';
      this.log.error(`${LOG} ${reason}: exit FAILED on ${a.symbol} (${a.trackerId}): ${msg}`);
      await this.throttledNotify(a, now, `Supreme exit FAILED on ${a.symbol}: ${msg}. Exit it yourself if you agree.`);
    }
  }

  private async markRoundTrip(a: AlarmRow, extra: Record<string, unknown>): Promise<void> {
    a.payload = { ...(a.payload ?? {}), roundTrip: true, ...extra };
    await this.alarmRepo.update(a.id, { payload: a.payload });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private aiDown(): boolean {
    try {
      return this.aiHealth?.allDownSince() != null;
    } catch {
      return false;
    }
  }

  private async stillPastLimit(a: AlarmRow): Promise<boolean> {
    if (!HARD_LOSS_RULES.has(a.rule)) return false;
    if (!this.probe) {
      if (!this.warnedNoProbe) {
        this.warnedNoProbe = true;
        this.log.warn(`${LOG} HARD_LOSS_PROBE not bound: the hard-loss backstop cannot confirm the loss and will not sell`);
      }
      return false;
    }
    try {
      return await this.probe.stillPastLimit(a.trackerId);
    } catch (err) {
      this.log.error(`${LOG} hard-loss probe failed for ${a.symbol} (${a.trackerId}): ${(err as Error)?.message}`);
      return false;
    }
  }

  /** A sell is due but there is no exit path: ERROR every pass, Telegram at most every 5 min per alarm. */
  private async cannotAct(a: AlarmRow, what: string, now: Date): Promise<void> {
    this.log.error(`${LOG} ${what} due on ${a.symbol} (${a.trackerId}) but OWNER_EXIT is not bound: cannot exit`);
    await this.throttledNotify(a, now, `${what} is due on ${a.symbol} but the server has no exit path bound, so it CANNOT exit. Exit it yourself.\nAlarm ${a.rule}: ${a.reason}`);
  }

  private async throttledNotify(a: AlarmRow, now: Date, text: string): Promise<void> {
    const prev = this.cannotActAt.get(a.id);
    if (prev != null && now.getTime() - prev < CANNOT_ACT_REPEAT_MS) return;
    this.cannotActAt.set(a.id, now.getTime());
    await this.send(text);
  }

  private async alertText(a: AlarmRow, now: Date, header: string, aiDown: boolean): Promise<string> {
    const p = a.payload ?? {};
    const pnlRaw = p.netPnl ?? p.pnl;
    const pnl = typeof pnlRaw === 'number' && Number.isFinite(pnlRaw) ? `₹${Math.round(pnlRaw)}` : 'n/a';
    const mins = Math.floor((now.getTime() - a.raisedAt.getTime()) / 60_000);
    const lines = [
      `${header}: ${a.symbol}`,
      `Alarm: ${a.rule} (${a.urgency}): ${a.reason}`,
      `Old rule would have: ${a.wouldHave}`,
      `P&L: ${pnl}`,
      `Agent's last view: ${await this.lastView(a)}`,
    ];
    if (a.deadline) lines.push(`Deadline: ${istTime(a.deadline)} IST (code exits 2 min before it with no decision)`);
    if (aiDown) lines.push('Every AI route is DOWN right now.');
    lines.push(`Raised ${istTime(a.raisedAt)} IST, unanswered ${mins} min.`);
    lines.push('Exit = sell now (owner path). Hold = silence this alarm 15 min.');
    return lines.join('\n');
  }

  private async lastView(a: AlarmRow): Promise<string> {
    const p = a.payload ?? {};
    const view = p.agentView ?? p.lastView;
    if (typeof view === 'string' && view.trim()) return view.trim().slice(0, 600);
    try {
      const v = await this.alarmRepo.latestAgentVerdict(a.trackerId, new Date(0));
      return v ? `${v.verdict} at ${istTime(v.createdAt)} IST` : 'no agent verdict yet';
    } catch {
      return 'unknown';
    }
  }

  private async send(text: string, buttons?: InlineButton[][]): Promise<number | null> {
    try {
      return await this.telegram.sendMessage(text, buttons);
    } catch (err) {
      this.log.error(`${LOG} Telegram send failed: ${(err as Error)?.message}. Message was: ${text.slice(0, 300)}`);
      return null;
    }
  }

  private async edit(messageId: number, text: string, buttons?: InlineButton[][]): Promise<boolean> {
    try {
      await this.telegram.editMessage(messageId, text, buttons);
      return true;
    } catch (err) {
      this.log.warn(`${LOG} Telegram edit of ${messageId} failed: ${(err as Error)?.message}`);
      return false;
    }
  }
}
