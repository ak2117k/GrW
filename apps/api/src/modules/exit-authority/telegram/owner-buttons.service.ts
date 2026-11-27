import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { DEADLINE_EXIT_LEAD_MS, OWNER_HOLD_SNOOZE_MS } from '../domain/timings';
import type { AlarmRow, OwnerEscalationPort } from '../exit-authority.tokens';
import { EscalationRepository } from '../repositories/escalation.repository';
import { TradeAlarmRepository } from '../repositories/trade-alarm.repository';
import { AuthorityStateService } from '../services/authority-state.service';
import { OWNER_EXIT, alarmButtons, deleteQuietly, istTime, type OwnerExitPort } from '../services/escalation-runner.service';
import { TelegramBotClient, type InlineButton, type TelegramCallbackQuery } from './telegram-bot.client';
import { TrackerMessages } from './tracker-messages';

const LOG = '[exit-authority]';
const POLL_TIMEOUT_SEC = 25;
const POLL_ERROR_BACKOFF_MS = 5_000;
/** An Exit tap on a message not sent/edited in this long is refused: a stale tap must never sell. */
export const EXIT_TAP_MAX_AGE_MS = 30 * 60_000;

const blockedButtons = (trackerId: string): InlineButton[][] => [
  [
    { text: 'Exit', data: `bx:${trackerId}` },
    { text: 'Hold', data: `bh:${trackerId}` },
  ],
];

interface BlockedState {
  key: string;
  heldUntil: number | null;
}

/** When an owner Hold ends: 15 min, but never past the deadline backstop of a `deadline` alarm. */
export function holdUntil(a: Pick<AlarmRow, 'urgency' | 'deadline'>, now: Date): Date {
  const snooze = now.getTime() + OWNER_HOLD_SNOOZE_MS;
  if (a.urgency === 'deadline' && a.deadline != null) {
    return new Date(Math.min(snooze, a.deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
  }
  return new Date(snooze);
}

/**
 * The owner's side of the escalation (design §4.5 B, §4.5b):
 *  - Exit / Hold buttons on alarm messages (`x:<alarmId>` / `h:<alarmId>`): Exit goes through the owner path
 *    (OWNER_EXIT, the app's Exit-now pipeline) and closes the alarm; Hold snoozes it OWNER_HOLD_SNOOZE_MS
 *    (capped at a deadline alarm's backstop time) and restarts the owner-silence clock.
 *  - blockedExit(): a confirmed exit stopped by the owner's own resting order → Exit / Hold on that tracker
 *    (`bx:<trackerId>` / `bh:<trackerId>`), on the trade's one live message.
 *
 * A tap is obeyed only from TELEGRAM_ALERT_CHAT_ID AND from the owner (TELEGRAM_ALERT_OWNER_USER_ID when set,
 * else the chat must be a private chat), only on alarms still OPEN/SNOOZED, and an Exit only on a message
 * sent/edited in the last 30 min. Taps arrive by long-polling getUpdates, only in the boot-jobs container and
 * only while the authority is live.
 */
@Injectable()
export class OwnerButtonsService implements OwnerEscalationPort, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(OwnerButtonsService.name);
  private offset = 0;
  private stopped = false;
  private polling = false;
  private readonly inFlight = new Set<string>();
  private readonly blocked = new Map<string, BlockedState>();

  constructor(
    private readonly telegram: TelegramBotClient,
    private readonly alarmRepo: TradeAlarmRepository,
    private readonly esc: EscalationRepository,
    private readonly state: AuthorityStateService,
    private readonly messages: TrackerMessages,
    @Optional() @Inject(OWNER_EXIT) private readonly ownerExit?: OwnerExitPort,
  ) {}

  onApplicationBootstrap(): void {
    if (!bootJobsEnabled()) {
      this.log.log(`${LOG} owner buttons: ${BOOT_JOBS_DISABLED}`);
      return;
    }
    void this.state.ready.then(() => {
      if (this.state.isLive() && !this.stopped) void this.pollLoop();
    });
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  private async pollLoop(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.log.log(`${LOG} owner buttons: polling Telegram for Exit / Hold taps`);
    try {
      while (!this.stopped && this.state.isLive()) {
        try {
          await this.pollOnce(new Date());
        } catch (err) {
          this.log.warn(`${LOG} owner buttons: getUpdates failed: ${(err as Error)?.message}`);
          await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async pollOnce(now: Date = new Date()): Promise<void> {
    const updates = await this.telegram.getUpdates(this.offset, POLL_TIMEOUT_SEC);
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      if (!u.callback_query) continue;
      try {
        await this.handleCallback(u.callback_query, now);
      } catch (err) {
        this.log.error(`${LOG} owner buttons: callback ${u.callback_query.data ?? '?'} failed: ${(err as Error)?.message}`);
      }
    }
  }

  async handleCallback(cq: TelegramCallbackQuery, now: Date = new Date()): Promise<void> {
    const why = this.refusal(cq);
    if (why) {
      this.log.warn(`${LOG} owner buttons: ignored a tap (${why}) chat=${cq.message?.chat?.id ?? '?'} from=${cq.from?.id ?? '?'}`);
      return this.answer(cq, 'not allowed');
    }
    const m = /^(x|h|bx|bh):(.+)$/.exec(cq.data ?? '');
    if (!m) return this.answer(cq, 'unknown button');
    const [, kind, id] = m;
    if ((kind === 'x' || kind === 'bx') && this.tooOld(cq, now)) {
      this.log.warn(`${LOG} owner buttons: refused a stale Exit tap (${cq.data}): message older than 30 min`);
      return this.answer(cq, 'expired — use the app');
    }
    const key = `${kind[0] === 'b' ? 'trk' : 'alarm'}:${id}`;
    if (this.inFlight.has(key)) return this.answer(cq, 'working on it');
    this.inFlight.add(key);
    try {
      if (kind === 'x' || kind === 'h') await this.alarmTap(cq, kind, id, now);
      else await this.blockedTap(cq, kind as 'bx' | 'bh', id, now);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** null = the tap comes from the configured chat and from the owner. */
  private refusal(cq: TelegramCallbackQuery): string | null {
    const chat = cq.message?.chat;
    const allowedChat = this.telegram.chatId();
    if (chat?.id == null || !allowedChat || String(chat.id) !== allowedChat) return 'wrong chat';
    const owner = this.telegram.ownerUserId();
    if (owner) {
      if (cq.from?.id == null || String(cq.from.id) !== owner) return 'not the owner user';
    } else if (chat.type !== 'private') {
      return 'group chat without TELEGRAM_ALERT_OWNER_USER_ID';
    }
    return null;
  }

  /** The message's last send/edit time; unknown counts as too old. */
  private tooOld(cq: TelegramCallbackQuery, now: Date): boolean {
    const sec = Math.max(cq.message?.date ?? 0, cq.message?.edit_date ?? 0);
    return sec <= 0 || now.getTime() - sec * 1000 > EXIT_TAP_MAX_AGE_MS;
  }

  async blockedExit(input: { userId: string; trackerId: string; symbol: string; reason: string; detail: string }): Promise<void> {
    if (!this.state.isLive()) return;
    const now = Date.now();
    const key = `${input.reason}|${input.detail}`;
    const prev = this.blocked.get(input.trackerId);
    if (prev?.key === key) return; // at most once per execution row (the detail names it)
    if (prev?.heldUntil != null && prev.heldUntil > now) {
      this.blocked.set(input.trackerId, { key, heldUntil: prev.heldUntil });
      return;
    }
    this.blocked.set(input.trackerId, { key, heldUntil: null });
    const text = [
      `EXIT BLOCKED BY YOUR RESTING ORDER: ${input.symbol}`,
      `Reason: ${input.reason}`,
      input.detail,
      'The confirmed exit was not sent; your order was not touched.',
      'Exit = sell now via the owner path (cancels your order). Hold = leave it (15 min).',
    ].join('\n');
    // Needs the owner's attention: a FRESH message (it rings), then the trade's previous one is deleted, so the
    // trade still has one live message (§4.5 B). The id is persisted on the trade's tracked alarms.
    // The DB is the source of truth (the runner in another container may have replaced the message); memory is
    // the fallback when the read fails or nothing is persisted.
    let old: number | null = null;
    try {
      old = await this.esc.trackerMessageId(input.trackerId);
    } catch (err) {
      this.log.warn(`${LOG} blocked-exit: message id read failed for ${input.trackerId} (using memory): ${(err as Error)?.message}`);
    }
    if (old == null) old = this.messages.get(input.trackerId);
    let sent: number;
    try {
      sent = await this.telegram.sendMessage(text, blockedButtons(input.trackerId));
    } catch (err) {
      this.log.error(`${LOG} blocked-exit alert for ${input.symbol} (${input.trackerId}) NOT SENT: ${(err as Error)?.message}`);
      return;
    }
    this.messages.set(input.trackerId, sent);
    if (old != null && old !== sent) await deleteQuietly(this.telegram, old, this.log);
    try {
      await this.esc.setTrackerMessageId(input.trackerId, sent);
    } catch (err) {
      this.log.warn(`${LOG} could not persist message ${sent} for tracker ${input.trackerId}: ${(err as Error)?.message}`);
    }
  }

  // ── taps ─────────────────────────────────────────────────────────────────

  private async alarmTap(cq: TelegramCallbackQuery, kind: string, alarmId: string, now: Date): Promise<void> {
    const a = await this.esc.findById(alarmId);
    if (!a || (a.status !== 'OPEN' && a.status !== 'SNOOZED')) return this.answer(cq, 'already handled');
    const messageId = cq.message?.message_id ?? a.telegramMessageId;

    if (kind === 'h') {
      const until = holdUntil(a, now);
      // The owner answered: the owner-silence clock restarts. After the snooze a fresh ALERT goes out first,
      // and the hard-loss backstop needs another 10 min of silence after THAT alert (§4.5a.1).
      await this.alarmRepo.update(a.id, { status: 'SNOOZED', snoozedUntil: until, alertedAt: null, alertCount: 0 });
      this.log.warn(`${LOG} owner HOLD on ${a.symbol} ${a.rule} (alarm ${a.id}) until ${until.toISOString()}`);
      await this.answer(cq, `Held until ${istTime(until)} IST`);
      if (messageId != null) {
        const capped = until.getTime() < now.getTime() + OWNER_HOLD_SNOOZE_MS ? ' (capped: broker deadline)' : '';
        await this.edit(messageId, `${a.symbol}: HELD by you until ${istTime(until)} IST${capped}.\nAlarm ${a.rule}: ${a.reason}`, alarmButtons(a.id));
      }
      return;
    }

    if (!this.ownerExit) {
      this.log.error(`${LOG} owner tapped Exit on ${a.symbol} (alarm ${a.id}) but OWNER_EXIT is not bound: cannot exit`);
      await this.answer(cq, 'Exit path not available: use the app');
      await this.notify(`Exit on ${a.symbol} could NOT be sent: the server has no exit path bound. Use the app's Exit button.`);
      return;
    }
    let result: string;
    try {
      // The owner's own tap: owner-initiated (the only kind of exit allowed to cancel the owner's orders under live).
      result = await this.ownerExit.exitAsOwner(a.userId, a.trackerId, 'OWNER via Telegram', { ownerInitiated: true });
    } catch (err) {
      const msg = (err as Error)?.message ?? 'error';
      this.log.error(`${LOG} owner Exit via Telegram FAILED on ${a.symbol} (${a.trackerId}): ${msg}`);
      await this.answer(cq, 'Exit FAILED: use the app');
      await this.notify(`Exit on ${a.symbol} FAILED: ${msg}. Use the app's Exit button.`);
      return;
    }
    await this.alarmRepo.update(a.id, { status: 'CLOSED' });
    this.log.warn(`${LOG} owner EXIT via Telegram on ${a.symbol} (alarm ${a.id}) → ${result}`);
    await this.answer(cq, 'Exit sent');
    if (messageId != null) await this.edit(messageId, `${a.symbol}: Exit sent (you, via Telegram, ${istTime(now)} IST; ${result}).`);
  }

  private async blockedTap(cq: TelegramCallbackQuery, kind: 'bx' | 'bh', trackerId: string, now: Date): Promise<void> {
    const t = await this.esc.tracker(trackerId);
    if (!t || t.status !== 'OPEN') return this.answer(cq, 'already handled');
    const messageId = cq.message?.message_id;

    if (kind === 'bh') {
      const prev = this.blocked.get(trackerId);
      this.blocked.set(trackerId, { key: prev?.key ?? '', heldUntil: now.getTime() + OWNER_HOLD_SNOOZE_MS });
      await this.answer(cq, 'Held: your order stays');
      if (messageId != null) await this.edit(messageId, `${t.symbol}: HELD by you. Your resting order stays; no exit sent.`);
      return;
    }

    if (!this.ownerExit) {
      this.log.error(`${LOG} owner tapped Exit on blocked ${t.symbol} but OWNER_EXIT is not bound: cannot exit`);
      await this.answer(cq, 'Exit path not available: use the app');
      await this.notify(`Exit on ${t.symbol} could NOT be sent: the server has no exit path bound. Use the app.`);
      return;
    }
    try {
      const result = await this.ownerExit.exitAsOwner(t.userId, t.id, 'OWNER via Telegram (exit blocked by resting order)', { ownerInitiated: true });
      this.blocked.delete(trackerId);
      await this.answer(cq, 'Exit sent');
      if (messageId != null) await this.edit(messageId, `${t.symbol}: Exit sent (you, via Telegram; ${result}).`);
    } catch (err) {
      const msg = (err as Error)?.message ?? 'error';
      this.log.error(`${LOG} owner Exit (blocked) via Telegram FAILED on ${t.symbol}: ${msg}`);
      await this.answer(cq, 'Exit FAILED: use the app');
      await this.notify(`Exit on ${t.symbol} FAILED: ${msg}. Use the app.`);
    }
  }

  // ── telegram helpers (never throw) ───────────────────────────────────────

  private async answer(cq: TelegramCallbackQuery, text: string): Promise<void> {
    try {
      await this.telegram.answerCallback(cq.id, text);
    } catch (err) {
      this.log.warn(`${LOG} answerCallbackQuery failed: ${(err as Error)?.message}`);
    }
  }

  private async edit(messageId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
    try {
      await this.telegram.editMessage(messageId, text, buttons);
    } catch (err) {
      this.log.warn(`${LOG} Telegram edit of ${messageId} failed: ${(err as Error)?.message}`);
    }
  }

  private async notify(text: string): Promise<void> {
    try {
      await this.telegram.sendMessage(text);
    } catch (err) {
      this.log.error(`${LOG} Telegram send failed: ${(err as Error)?.message}. Message was: ${text.slice(0, 300)}`);
    }
  }
}
