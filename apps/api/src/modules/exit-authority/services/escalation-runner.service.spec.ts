import { Logger } from '@nestjs/common';
import type { AiHealthPort } from '../../ai-gateway/audit/failover-transport';
import {
  BACKSTOP_OWNER_SILENT_MS,
  DEADLINE_BACKSTOP_GRACE_MS,
  DEADLINE_EXIT_LEAD_MS,
  ESCALATE_AFTER_MS,
  ESCALATE_URGENT_AFTER_MS,
  REALERT_EVERY_MS,
  SUPREME_EXIT_AGENT_LOOK_MS,
} from '../domain/timings';
import type { AlarmRow, ConfirmResult, SupremeConfirmPort, TradeAlarmsPort } from '../exit-authority.tokens';
import type { EscalationRepository } from '../repositories/escalation.repository';
import type { AgentVerdictRef, TradeAlarmPatch, TradeAlarmRepository } from '../repositories/trade-alarm.repository';
import { TelegramBotClient as RealTelegramBotClient, type TelegramBotClient } from '../telegram/telegram-bot.client';
import { TrackerMessages } from '../telegram/tracker-messages';
import { holdUntil } from '../telegram/owner-buttons.service';
import type { AuthorityStateService } from './authority-state.service';
import { BackstopRehearsal, EscalationRunner, type HardLossProbe, type OwnerExitPort } from './escalation-runner.service';

const T0 = new Date('2026-11-27T05:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

/** One in-memory store standing in for trade_alarms + sentinel_verdicts + trade_trackers. */
class FakeDb {
  alarms: AlarmRow[] = [];
  verdicts: Array<AgentVerdictRef & { trackerId: string }> = [];
  openTrackers = new Set<string>(['trk1']);

  // TradeAlarmRepository subset
  async update(id: string, patch: TradeAlarmPatch): Promise<AlarmRow> {
    const r = this.alarms.find((x) => x.id === id);
    if (!r) throw new Error(`no alarm ${id}`);
    Object.assign(r, patch);
    return { ...r };
  }
  async latestAgentVerdict(trackerId: string, since: Date): Promise<AgentVerdictRef | null> {
    const v = this.verdicts
      .filter((x) => x.trackerId === trackerId && x.createdAt.getTime() > since.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return v ? { id: v.id, verdict: v.verdict, createdAt: v.createdAt } : null;
  }
  // EscalationRepository subset
  async findForRunner(): Promise<AlarmRow[]> {
    return this.alarms.filter((a) => ['OPEN', 'SNOOZED', 'ANSWERED'].includes(a.status)).map((a) => ({ ...a, payload: a.payload ? { ...a.payload } : undefined }));
  }
  async openTrackerIds(ids: string[]): Promise<Set<string>> {
    return new Set(ids.filter((i) => this.openTrackers.has(i)));
  }
  async trackerMessageId(trackerId: string): Promise<number | null> {
    const r = this.alarms
      .filter((a) => a.trackerId === trackerId && ['OPEN', 'SNOOZED', 'ANSWERED'].includes(a.status) && a.telegramMessageId != null)
      .sort((x, y) => y.lastRaisedAt.getTime() - x.lastRaisedAt.getTime())[0];
    return r?.telegramMessageId ?? null;
  }
  async setTrackerMessageId(trackerId: string, messageId: number): Promise<void> {
    for (const a of this.alarms) {
      if (a.trackerId === trackerId && ['OPEN', 'SNOOZED', 'ANSWERED'].includes(a.status)) a.telegramMessageId = messageId;
    }
  }
  /** ai_exit_executions by verdictId. */
  executions = new Map<string, { status: string; reason: string | null }>();
  async executionForVerdict(verdictId: string): Promise<{ status: string; reason: string | null } | null> {
    return this.executions.get(verdictId) ?? null;
  }
  /** intraday_carry_decisions CONVERTED trackers. */
  converted = new Set<string>();
  async carryConverted(trackerId: string): Promise<boolean> {
    return this.converted.has(trackerId);
  }
}

function alarm(over: Partial<AlarmRow> = {}): AlarmRow {
  return {
    id: 'a1',
    userId: 'owner1',
    trackerId: 'trk1',
    symbol: 'BHARATFORG25DEC1800CE',
    rule: 'FLOOR',
    urgency: 'normal',
    reason: 'green-to-red floor broken',
    wouldHave: 'EXIT_NOW FLOOR_HARD_EXIT GREEN_TO_RED',
    deadline: null,
    severityN: 0.5,
    sourceRef: null,
    payload: { netPnl: -1234.4, agentView: 'HOLD: pullback into support, thesis intact' },
    status: 'OPEN',
    raisedAt: T0,
    lastRaisedAt: T0,
    answeredAt: null,
    answerVerdictId: null,
    answer: null,
    alertedAt: null,
    alertCount: 0,
    telegramMessageId: null,
    snoozedUntil: null,
    ...over,
  };
}

function setup(opts: { ownerExit?: boolean; probe?: boolean; aiDown?: boolean; confirm?: ConfirmResult['decision'] | 'throw'; live?: boolean } = {}) {
  const db = new FakeDb();
  const alarms: TradeAlarmsPort & { answer: jest.Mock } = {
    raise: jest.fn(),
    openFor: jest.fn(),
    openForTrackers: jest.fn(),
    answer: jest.fn(async (id: string, verdictId: string, answer: string, now?: Date) => {
      await db.update(id, { status: 'ANSWERED', answeredAt: now ?? new Date(), answerVerdictId: verdictId, answer });
    }),
  };
  let msgSeq = 100;
  const telegram = {
    sendMessage: jest.fn(async (_text: string, _buttons?: unknown) => ++msgSeq),
    editMessage: jest.fn(async (_id: number, _text: string, _buttons?: unknown) => undefined),
    deleteMessage: jest.fn(async (_id: number) => undefined),
  };
  const ownerExit: OwnerExitPort & { exitAsOwner: jest.Mock } = { exitAsOwner: jest.fn(async () => 'man_trk1_1') };
  const probe: HardLossProbe & { stillPastLimit: jest.Mock } = { stillPastLimit: jest.fn(async () => opts.probe ?? true) };
  const aiHealth: AiHealthPort = { allDownSince: () => (opts.aiDown ? T0.getTime() : null) };
  const supreme: SupremeConfirmPort & { confirm: jest.Mock } = {
    confirm: jest.fn(async () => {
      if (opts.confirm === 'throw') throw new Error('vertex 500');
      return { decision: opts.confirm ?? 'CONFIRM', reason: 'supreme says go', latencyMs: 5 };
    }),
  };
  const state = { isLive: () => opts.live ?? true } as unknown as AuthorityStateService;
  const make = () =>
    new EscalationRunner(
      db as unknown as TradeAlarmRepository,
      db as unknown as EscalationRepository,
      alarms,
      state,
      telegram as unknown as TelegramBotClient,
      new TrackerMessages(),
      opts.ownerExit === false ? undefined : ownerExit,
      probe,
      aiHealth,
      supreme,
      undefined,
    );
  return { db, alarms, telegram, ownerExit, probe, supreme, runner: make(), make };
}

describe('EscalationRunner.pass', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.BOOT_JOBS;
  });

  describe('resolve', () => {
    it('an OPEN alarm with an LLM verdict after raisedAt → answer()', async () => {
      const { db, alarms, telegram, runner } = setup();
      db.alarms.push(alarm());
      db.verdicts.push({ id: 'v-old', verdict: 'EXIT_ARMED', createdAt: at(-60_000), trackerId: 'trk1' });
      db.verdicts.push({ id: 'v1', verdict: 'HOLD', createdAt: at(20_000), trackerId: 'trk1' });
      await runner.pass(at(ESCALATE_AFTER_MS + 1));
      expect(alarms.answer).toHaveBeenCalledWith('a1', 'v1', 'HOLD', at(ESCALATE_AFTER_MS + 1));
      expect(db.alarms[0].status).toBe('ANSWERED');
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('a verdict older than the alarm does not resolve it', async () => {
      const { db, alarms, runner } = setup();
      db.alarms.push(alarm());
      db.verdicts.push({ id: 'v-old', verdict: 'HOLD', createdAt: at(-1), trackerId: 'trk1' });
      await runner.pass(at(10_000));
      expect(alarms.answer).not.toHaveBeenCalled();
    });
  });

  describe('escalate', () => {
    it('not yet due → nothing sent', async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm());
      await runner.pass(at(ESCALATE_AFTER_MS - 1));
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it("ALERT → one message with the trade, reason, agent's last view, P&L and Exit/Hold buttons; id + alertedAt stored", async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm());
      const now = at(ESCALATE_AFTER_MS);
      await runner.pass(now);
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
      const [text, buttons] = telegram.sendMessage.mock.calls[0] as unknown as [string, unknown];
      expect(text).toContain('BHARATFORG25DEC1800CE');
      expect(text).toContain('green-to-red floor broken');
      expect(text).toContain('HOLD: pullback into support, thesis intact');
      expect(text).toContain('₹-1234');
      expect(buttons).toEqual([
        [
          { text: 'Exit', data: 'x:a1' },
          { text: 'Hold', data: 'h:a1' },
        ],
      ]);
      expect(db.alarms[0]).toMatchObject({ telegramMessageId: 101, alertedAt: now, alertCount: 1 });

      await runner.pass(at(ESCALATE_AFTER_MS + 15_000));
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1); // no second message
    });

    it('urgent alarms alert after 60 s', async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm({ rule: 'HARD_LOSS', urgency: 'urgent' }));
      await runner.pass(at(ESCALATE_URGENT_AFTER_MS));
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('the agent last view falls back to the newest LLM verdict when the payload has none', async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm({ payload: { netPnl: -10 } }));
      db.verdicts.push({ id: 'v0', verdict: 'EXIT_ARMED', createdAt: at(-120_000), trackerId: 'trk1' });
      await runner.pass(at(ESCALATE_AFTER_MS));
      expect(String(telegram.sendMessage.mock.calls[0][0])).toContain('EXIT_ARMED at');
    });

    it('every AI route down → alert at once (no 2-min wait)', async () => {
      const { db, telegram, runner } = setup({ aiDown: true });
      db.alarms.push(alarm());
      await runner.pass(at(5_000));
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
      expect(String(telegram.sendMessage.mock.calls[0][0])).toContain('AI route is DOWN');
    });

    it('REALERT → a fresh message (rings) + delete of the old one, alertCount++, then every 5 min from the first alert', async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm({ alertedAt: at(0), alertCount: 1, telegramMessageId: 55 }));
      await runner.pass(at(REALERT_EVERY_MS));
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
      expect(telegram.deleteMessage).toHaveBeenCalledWith(55);
      expect(telegram.editMessage).not.toHaveBeenCalled();
      expect(db.alarms[0]).toMatchObject({ alertCount: 2, telegramMessageId: 101, alertedAt: at(0) });

      await runner.pass(at(REALERT_EVERY_MS + 15_000));
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
      await runner.pass(at(2 * REALERT_EVERY_MS));
      expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
      expect(telegram.deleteMessage).toHaveBeenLastCalledWith(101);
      expect(db.alarms[0]).toMatchObject({ alertCount: 3, telegramMessageId: 102 });
    });

    it('cross-container: an id persisted by another process overrides memory for the REALERT delete and the answered edit', async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm({ alertedAt: at(0), alertCount: 1, telegramMessageId: 55 }));
      await runner.pass(at(REALERT_EVERY_MS)); // this process: sends 101, deletes 55, memory = 101
      expect(telegram.deleteMessage).toHaveBeenLastCalledWith(55);
      // blockedExit in another container sends 77, deletes 101 and persists 77 on the rows.
      await db.setTrackerMessageId('trk1', 77);
      await runner.pass(at(2 * REALERT_EVERY_MS));
      expect(telegram.deleteMessage).toHaveBeenLastCalledWith(77); // not the stale in-memory 101
      expect(db.alarms[0].telegramMessageId).toBe(102);

      // Again from another process, then the agent answers: the in-place edit targets the persisted id.
      await db.setTrackerMessageId('trk1', 88);
      db.verdicts.push({ id: 'v1', verdict: 'HOLD', createdAt: at(2 * REALERT_EVERY_MS + 1_000), trackerId: 'trk1' });
      await runner.pass(at(2 * REALERT_EVERY_MS + 15_000));
      expect(telegram.editMessage).toHaveBeenCalledTimes(1);
      expect(telegram.editMessage.mock.calls[0][0]).toBe(88);
    });

    it('a failed DB read of the message id falls back to memory', async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm({ alertedAt: at(0), alertCount: 1, telegramMessageId: 55 }));
      await runner.pass(at(REALERT_EVERY_MS)); // memory = 101
      jest.spyOn(db, 'trackerMessageId').mockRejectedValueOnce(new Error('db down'));
      await runner.pass(at(2 * REALERT_EVERY_MS));
      expect(telegram.deleteMessage).toHaveBeenLastCalledWith(101);
    });

    it('a failed delete of the old message is ignored (WARN); the new message stands', async () => {
      const { db, telegram, runner } = setup();
      telegram.deleteMessage.mockRejectedValueOnce(new Error('deleteMessage failed: HTTP 400 message to delete not found'));
      db.alarms.push(alarm({ alertedAt: at(0), alertCount: 1, telegramMessageId: 55 }));
      await expect(runner.pass(at(REALERT_EVERY_MS))).resolves.toBeUndefined();
      expect(db.alarms[0]).toMatchObject({ alertCount: 2, telegramMessageId: 101 });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('a failed fresh send keeps the old message as the trade message (nothing deleted)', async () => {
      const { db, telegram, runner } = setup();
      telegram.sendMessage.mockRejectedValueOnce(new Error('sendMessage failed: HTTP 502'));
      db.alarms.push(alarm({ alertedAt: at(0), alertCount: 1, telegramMessageId: 55 }));
      await runner.pass(at(REALERT_EVERY_MS));
      expect(telegram.deleteMessage).not.toHaveBeenCalled();
      expect(db.alarms[0]).toMatchObject({ alertCount: 2, telegramMessageId: 55 });
    });

    it('answered → the trade message is edited in place only (no send, no delete)', async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm({ alertedAt: at(ESCALATE_AFTER_MS), alertCount: 1, telegramMessageId: 55 }));
      db.verdicts.push({ id: 'v1', verdict: 'HOLD', createdAt: at(ESCALATE_AFTER_MS + 5_000), trackerId: 'trk1' });
      await runner.pass(at(ESCALATE_AFTER_MS + 15_000));
      expect(telegram.editMessage).toHaveBeenCalledTimes(1);
      expect(telegram.editMessage.mock.calls[0][0]).toBe(55);
      expect(telegram.sendMessage).not.toHaveBeenCalled();
      expect(telegram.deleteMessage).not.toHaveBeenCalled();
    });

    it('"message is not modified" on an in-place edit is success: no new send', async () => {
      const db = new FakeDb();
      db.alarms.push(alarm({ alertedAt: at(ESCALATE_AFTER_MS), alertCount: 1, telegramMessageId: 55 }));
      db.verdicts.push({ id: 'v1', verdict: 'HOLD', createdAt: at(ESCALATE_AFTER_MS + 5_000), trackerId: 'trk1' });
      const fetchMock = jest.fn(async (url: string) => ({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: `Bad Request: message is not modified (${url.split('/').pop()})` }),
      }));
      const client = new RealTelegramBotClient({ env: { TELEGRAM_ALERT_BOT_TOKEN: 't', TELEGRAM_ALERT_CHAT_ID: '-1' }, fetch: fetchMock });
      const alarms = { answer: jest.fn(async (id: string, vid: string, ans: string, now?: Date) => void (await db.update(id, { status: 'ANSWERED', answeredAt: now ?? null, answerVerdictId: vid, answer: ans }))) };
      const runner = new EscalationRunner(
        db as unknown as TradeAlarmRepository,
        db as unknown as EscalationRepository,
        alarms as unknown as TradeAlarmsPort,
        { isLive: () => true } as unknown as AuthorityStateService,
        client,
        new TrackerMessages(),
      );
      await runner.pass(at(ESCALATE_AFTER_MS + 15_000));
      const methods = fetchMock.mock.calls.map((c) => String(c[0]).split('/').pop());
      expect(methods).toEqual(['editMessageText']);
    });

    it('a failed send still records alertedAt (the owner was unreachable)', async () => {
      const { db, telegram, runner } = setup();
      telegram.sendMessage.mockRejectedValueOnce(new Error('sendMessage failed: HTTP 502'));
      db.alarms.push(alarm());
      await runner.pass(at(ESCALATE_AFTER_MS));
      expect(db.alarms[0]).toMatchObject({ alertedAt: at(ESCALATE_AFTER_MS), alertCount: 1, telegramMessageId: null });
      expect(errorSpy).toHaveBeenCalled();
    });

    it('a live owner snooze silences it', async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm({ status: 'SNOOZED', snoozedUntil: at(900_000), alertedAt: at(0), alertCount: 1, telegramMessageId: 55 }));
      await runner.pass(at(REALERT_EVERY_MS));
      expect(telegram.editMessage).not.toHaveBeenCalled();
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('backstop', () => {
    const deadline = at(30 * 60_000);
    it("DEADLINE → owner exit with 'BACKSTOP DEADLINE: …', BACKSTOPPED, Telegram told", async () => {
      const { db, ownerExit, telegram, runner } = setup();
      db.alarms.push(alarm({ rule: 'CARRY', urgency: 'deadline', deadline, alertedAt: at(0), alertCount: 1, telegramMessageId: 55 }));
      await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
      expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
      const [user, trk, reason] = ownerExit.exitAsOwner.mock.calls[0];
      expect(user).toBe('owner1');
      expect(trk).toBe('trk1');
      expect(reason).toMatch(/^BACKSTOP DEADLINE: /);
      expect(db.alarms[0].status).toBe('BACKSTOPPED');
      expect(String(telegram.sendMessage.mock.calls.at(-1)?.[0])).toContain('BACKSTOP DEADLINE');
    });

    it("HARD_LOSS (AI down, owner silent 10 min, still past limit) → 'BACKSTOP HARD_LOSS: …'", async () => {
      const { db, ownerExit, probe, runner } = setup({ aiDown: true, probe: true });
      db.alarms.push(alarm({ rule: 'HARD_LOSS', urgency: 'urgent', alertedAt: at(60_000), alertCount: 2, telegramMessageId: 55 }));
      await runner.pass(at(60_000 + BACKSTOP_OWNER_SILENT_MS));
      expect(probe.stillPastLimit).toHaveBeenCalledWith('trk1');
      expect(ownerExit.exitAsOwner.mock.calls[0][2]).toMatch(/^BACKSTOP HARD_LOSS: /);
      expect(db.alarms[0].status).toBe('BACKSTOPPED');
    });

    it('HARD_LOSS no longer past the limit → no exit', async () => {
      const { db, ownerExit, runner } = setup({ aiDown: true, probe: false });
      db.alarms.push(alarm({ rule: 'HARD_LOSS', urgency: 'urgent', alertedAt: at(60_000), alertCount: 2, telegramMessageId: 55 }));
      await runner.pass(at(60_000 + BACKSTOP_OWNER_SILENT_MS));
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
      expect(db.alarms[0].status).toBe('OPEN');
    });

    it('not due (owner alerted < 10 min ago) → no exit and no probe', async () => {
      const { db, ownerExit, probe, runner } = setup({ aiDown: true });
      db.alarms.push(alarm({ rule: 'HARD_LOSS', urgency: 'urgent', alertedAt: at(60_000), alertCount: 1, telegramMessageId: 55 }));
      await runner.pass(at(60_000 + BACKSTOP_OWNER_SILENT_MS - 1));
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
      expect(probe.stillPastLimit).not.toHaveBeenCalled();
    });

    it('OWNER_EXIT absent → ERROR log + Telegram line saying it cannot exit; status unchanged', async () => {
      const { db, telegram, runner } = setup({ ownerExit: false });
      db.alarms.push(alarm({ rule: 'CARRY', urgency: 'deadline', deadline, alertedAt: at(0), alertCount: 1, telegramMessageId: 55 }));
      await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
      expect(db.alarms[0].status).toBe('OPEN');
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/OWNER_EXIT is not bound/);
      expect(String(telegram.sendMessage.mock.calls.at(-1)?.[0])).toMatch(/CANNOT exit/);
    });

    it('backstops are never owner-initiated (they do not cancel the owner\'s resting order)', async () => {
      const { db, ownerExit, runner } = setup();
      db.alarms.push(alarm({ rule: 'CARRY', urgency: 'deadline', deadline, alertedAt: at(0), alertCount: 1 }));
      await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
      expect(ownerExit.exitAsOwner.mock.calls[0][3]).toEqual({ ownerInitiated: false });
    });

    it('AI_AUTO_EXIT_MODE=dry-run (BackstopRehearsal): recorded BACKSTOPPED + rehearsed, owner told "would exit", not retried', async () => {
      const { db, ownerExit, telegram, runner } = setup();
      ownerExit.exitAsOwner.mockRejectedValue(new BackstopRehearsal('AI_AUTO_EXIT_MODE=dry-run'));
      db.alarms.push(alarm({ rule: 'CARRY', urgency: 'deadline', deadline, alertedAt: at(0), alertCount: 1 }));
      await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
      expect(db.alarms[0].status).toBe('BACKSTOPPED');
      expect(db.alarms[0].payload).toMatchObject({ rehearsed: true });
      expect(String(telegram.sendMessage.mock.calls.at(-1)?.[0])).toMatch(/BACKSTOP DEADLINE \(dry-run\): would exit/);
      await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS + 15_000));
      expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
    });

    describe('owner ruling: an agent HOLD does not disarm the deadline backstop', () => {
      const held = () => alarm({ rule: 'CARRY', urgency: 'deadline', deadline, status: 'ANSWERED', answeredAt: at(60_000), answer: 'HOLD', answerVerdictId: 'v1' });

      it('answered HOLD → no exit before deadline − 2 min; exit at deadline − 2 min (BACKSTOP DEADLINE)', async () => {
        const { db, ownerExit, runner } = setup();
        db.alarms.push(held());
        await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS - 1_000));
        expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
        await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
        expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
        expect(ownerExit.exitAsOwner.mock.calls[0][2]).toMatch(/^BACKSTOP DEADLINE: /);
        expect(db.alarms[0].status).toBe('BACKSTOPPED');
      });

      it('converted to carry (the product read says CARRYFORWARD) → no backstop; the alarm is closed', async () => {
        const { db, ownerExit, probe, runner } = setup();
        (probe as HardLossProbe).productIntraday = jest.fn(() => false);
        db.alarms.push(held());
        await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
        expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
        expect(db.alarms[0].status).toBe('CLOSED');
      });

      it('converted to carry (the carry engine confirmed CONVERTED) → no backstop', async () => {
        const { db, ownerExit, runner } = setup();
        db.converted.add('trk1');
        db.alarms.push(held());
        await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
        expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
      });

      it('the product still intraday or unknown → backstop', async () => {
        for (const p of [true, null]) {
          const { db, ownerExit, probe, runner } = setup();
          (probe as HardLossProbe).productIntraday = jest.fn(() => p);
          db.alarms.push(held());
          await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
          expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
        }
      });

      it.each([
        ['answered HOLD', () => held()],
        ['unanswered', () => alarm({ rule: 'CARRY', urgency: 'deadline', deadline, alertedAt: at(0), alertCount: 1 })],
      ])('%s, more than 5 min past the deadline (e.g. a past session) → CLOSED, never sold, owner told', async (_n, make) => {
        const { db, ownerExit, telegram, runner } = setup();
        db.alarms.push(make());
        await runner.pass(new Date(deadline.getTime() + DEADLINE_BACKSTOP_GRACE_MS + 1));
        expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
        expect(db.alarms[0].status).toBe('CLOSED');
        expect(String(telegram.sendMessage.mock.calls.at(-1)?.[0])).toMatch(/deadline passed .* not acting, check the position/);
        await runner.pass(new Date(deadline.getTime() + DEADLINE_BACKSTOP_GRACE_MS + 60_000));
        expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
      });

      it('at deadline + 5 min exactly it still acts', async () => {
        const { db, ownerExit, runner } = setup();
        db.alarms.push(held());
        await runner.pass(new Date(deadline.getTime() + DEADLINE_BACKSTOP_GRACE_MS));
        expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
      });

      it('the tracker closed → CLOSED, no backstop', async () => {
        const { db, ownerExit, runner } = setup();
        db.openTrackers.clear();
        db.alarms.push(held());
        await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
        expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
        expect(db.alarms[0].status).toBe('CLOSED');
      });
    });

    it('a failed exit leaves the alarm open (retried next pass) and tells the owner', async () => {
      const { db, ownerExit, telegram, runner } = setup();
      ownerExit.exitAsOwner.mockRejectedValueOnce(new Error('QTY_UNIT_UNCONFIGURED:MCX'));
      db.alarms.push(alarm({ rule: 'CARRY', urgency: 'deadline', deadline, alertedAt: at(0), alertCount: 1 }));
      await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
      expect(db.alarms[0].status).toBe('OPEN');
      expect(String(telegram.sendMessage.mock.calls.at(-1)?.[0])).toMatch(/exit FAILED/);
      await runner.pass(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS + 15_000));
      expect(db.alarms[0].status).toBe('BACKSTOPPED');
    });
  });

  it('owner Hold resets owner silence: after the snooze a fresh alert goes out, and no HARD_LOSS backstop until 10 min after it', async () => {
    const { db, ownerExit, telegram, runner } = setup({ aiDown: true, probe: true });
    db.alarms.push(alarm({ rule: 'HARD_LOSS', urgency: 'urgent', alertedAt: at(60_000), alertCount: 2, telegramMessageId: 55 }));
    // The owner taps Hold at T0+3 min: the patch OwnerButtonsService writes.
    const holdAt = at(180_000);
    const until = holdUntil(db.alarms[0], holdAt);
    await db.update('a1', { status: 'SNOOZED', snoozedUntil: until, alertedAt: null, alertCount: 0 });

    await runner.pass(new Date(until.getTime() - 1)); // still snoozed: nothing
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();

    await runner.pass(until); // snooze over: a fresh (ringing) alert replaces the trade's message, not a sale
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.deleteMessage).toHaveBeenCalledWith(55);
    expect(db.alarms[0]).toMatchObject({ alertedAt: until, alertCount: 1, telegramMessageId: 101 });

    await runner.pass(new Date(until.getTime() + BACKSTOP_OWNER_SILENT_MS - 1));
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    await runner.pass(new Date(until.getTime() + BACKSTOP_OWNER_SILENT_MS));
    expect(ownerExit.exitAsOwner.mock.calls[0][2]).toMatch(/^BACKSTOP HARD_LOSS: /);
  });

  it('one live message per trade: a new alarm on the trade sends fresh (latest alarm id on the buttons) and deletes the old', async () => {
    const { db, telegram, runner } = setup();
    db.alarms.push(alarm());
    await runner.pass(at(ESCALATE_AFTER_MS));
    db.alarms.push(alarm({ id: 'a2', rule: 'LADDER', reason: 'ladder step lost', raisedAt: at(ESCALATE_AFTER_MS), lastRaisedAt: at(ESCALATE_AFTER_MS) }));
    await runner.pass(at(2 * ESCALATE_AFTER_MS));
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(telegram.deleteMessage).toHaveBeenCalledTimes(1);
    expect(telegram.deleteMessage).toHaveBeenCalledWith(101);
    const [text, buttons] = telegram.sendMessage.mock.calls[1];
    expect(text).toContain('ladder step lost');
    expect(buttons).toEqual([
      [
        { text: 'Exit', data: 'x:a2' },
        { text: 'Hold', data: 'h:a2' },
      ],
    ]);
    // Persisted on every tracked alarm of the trade, so another container / a restart sees the live one.
    expect(db.alarms.map((a) => a.telegramMessageId)).toEqual([102, 102]);
  });

  it('restart: a fresh runner on the same store resumes (re-alerts, does not re-send the first alert)', async () => {
    const { db, telegram, runner, make } = setup();
    db.alarms.push(alarm());
    await runner.pass(at(ESCALATE_AFTER_MS));
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const fresh = make();
    await fresh.pass(at(ESCALATE_AFTER_MS + 15_000));
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    await fresh.pass(at(ESCALATE_AFTER_MS + REALERT_EVERY_MS));
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(telegram.deleteMessage).toHaveBeenCalledWith(101); // the fresh runner found the live message in the rows
    expect(db.alarms[0].alertCount).toBe(2);
  });

  describe('close', () => {
    it('an ANSWERED alarm whose tracker is no longer OPEN → CLOSED', async () => {
      const { db, runner } = setup();
      db.alarms.push(alarm({ status: 'ANSWERED', answeredAt: at(10_000), answer: 'HOLD', answerVerdictId: 'v1' }));
      db.openTrackers.clear();
      await runner.pass(at(60_000));
      expect(db.alarms[0].status).toBe('CLOSED');
    });

    it('an OPEN alarm on a closed tracker → CLOSED, no alert, no exit', async () => {
      const { db, telegram, ownerExit, runner } = setup();
      db.alarms.push(alarm({ rule: 'CARRY', urgency: 'deadline', deadline: at(0) }));
      db.openTrackers.clear();
      await runner.pass(at(ESCALATE_AFTER_MS));
      expect(db.alarms[0].status).toBe('CLOSED');
      expect(telegram.sendMessage).not.toHaveBeenCalled();
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    });

    it('an ANSWERED alarm on an open tracker is left alone', async () => {
      const { db, runner } = setup();
      db.alarms.push(alarm({ status: 'ANSWERED', answeredAt: at(10_000), answer: 'HOLD', answerVerdictId: 'v1' }));
      await runner.pass(at(60 * 60_000));
      expect(db.alarms[0].status).toBe('ANSWERED');
    });
  });

  describe('SUPREME_EXIT (§4.4)', () => {
    const supremeAlarm = (over: Partial<AlarmRow> = {}) =>
      alarm({ rule: 'SUPREME_EXIT', urgency: 'urgent', reason: 'supreme asks EXIT: sector rolling over', payload: { decisionId: 'd1' }, ...over });

    it('unanswered < 60 s → waits', async () => {
      const { db, ownerExit, runner } = setup();
      db.alarms.push(supremeAlarm());
      await runner.pass(at(SUPREME_EXIT_AGENT_LOOK_MS - 1));
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    });

    it("unanswered ≥ 60 s → 'SUPREME_EXIT (agent silent): …', CLOSED, once", async () => {
      const { db, ownerExit, supreme, telegram, runner } = setup();
      db.alarms.push(supremeAlarm());
      await runner.pass(at(SUPREME_EXIT_AGENT_LOOK_MS));
      expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
      expect(ownerExit.exitAsOwner.mock.calls[0][2]).toMatch(/^SUPREME_EXIT \(agent silent\): supreme asks EXIT/);
      expect(db.alarms[0].status).toBe('CLOSED');
      expect(db.alarms[0].payload).toMatchObject({ roundTrip: true, decisionId: 'd1' });
      expect(supreme.confirm).not.toHaveBeenCalled();
      expect(telegram.sendMessage).not.toHaveBeenCalled(); // no owner escalation for supreme requests
    });

    it.each(['CONFIRM', 'TIMEOUT', 'ERROR', 'throw'] as const)(
      "agent HOLD → one SUPREME_CONFIRM with agentDisagrees → %s → 'SUPREME_EXIT (final): …'",
      async (decision) => {
        const { db, ownerExit, supreme, runner } = setup({ confirm: decision });
        db.alarms.push(supremeAlarm());
        db.verdicts.push({ id: 'v1', verdict: 'HOLD', createdAt: at(20_000), trackerId: 'trk1' });
        await runner.pass(at(30_000));
        expect(supreme.confirm).toHaveBeenCalledTimes(1);
        expect(supreme.confirm.mock.calls[0][0]).toMatchObject({ trackerId: 'trk1', agentDisagrees: true });
        expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
        expect(ownerExit.exitAsOwner.mock.calls[0][2]).toMatch(/^SUPREME_EXIT \(final\): /);
        expect(db.alarms[0].status).toBe('CLOSED');
        expect(db.alarms[0].payload?.roundTrip).toBe(true);
      },
    );

    it('agent EXIT_ARMED → confirm OVERRIDE_HOLD → no exit; the call is never repeated', async () => {
      const { db, ownerExit, supreme, runner, make } = setup({ confirm: 'OVERRIDE_HOLD' });
      db.alarms.push(supremeAlarm());
      db.verdicts.push({ id: 'v1', verdict: 'EXIT_ARMED', createdAt: at(20_000), trackerId: 'trk1' });
      await runner.pass(at(30_000));
      expect(supreme.confirm).toHaveBeenCalledTimes(1);
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
      expect(db.alarms[0]).toMatchObject({ status: 'ANSWERED', answer: 'EXIT_ARMED' });
      expect(db.alarms[0].payload).toMatchObject({ roundTrip: true, supreme: 'OVERRIDE_HOLD' });
      await runner.pass(at(120_000));
      await make().pass(at(400_000));
      expect(supreme.confirm).toHaveBeenCalledTimes(1);
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    });

    it('already answered by the sentinel with HOLD (ANSWERED row) → still one round trip', async () => {
      const { db, supreme, ownerExit, runner } = setup({ confirm: 'CONFIRM' });
      db.alarms.push(supremeAlarm({ status: 'ANSWERED', answeredAt: at(10_000), answer: 'HOLD', answerVerdictId: 'v1' }));
      await runner.pass(at(15_000));
      await runner.pass(at(30_000));
      expect(supreme.confirm).toHaveBeenCalledTimes(1);
      expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
    });

    it('a failed supreme exit is retried every pass (confirm still once) until it goes through', async () => {
      const { db, ownerExit, supreme, telegram, runner } = setup({ confirm: 'CONFIRM' });
      ownerExit.exitAsOwner.mockRejectedValueOnce(new Error('broker 500')).mockRejectedValueOnce(new Error('broker 500'));
      db.alarms.push(supremeAlarm());
      db.verdicts.push({ id: 'v1', verdict: 'HOLD', createdAt: at(20_000), trackerId: 'trk1' });
      await runner.pass(at(30_000));
      expect(db.alarms[0].payload).toMatchObject({ roundTrip: true, exitPending: true });
      expect(db.alarms[0].status).not.toBe('CLOSED');
      expect(String(telegram.sendMessage.mock.calls.at(-1)?.[0])).toMatch(/Supreme exit FAILED/);
      await runner.pass(at(45_000));
      expect(db.alarms[0].status).not.toBe('CLOSED');
      await runner.pass(at(60_000));
      expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(3);
      expect(ownerExit.exitAsOwner.mock.calls[2][2]).toMatch(/^SUPREME_EXIT \(final\): /);
      expect(db.alarms[0].status).toBe('CLOSED');
      expect(db.alarms[0].payload?.exitPending).toBe(false);
      expect(supreme.confirm).toHaveBeenCalledTimes(1);
      await runner.pass(at(75_000));
      expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(3);
    });

    it('a pending supreme exit stops when the trade closes', async () => {
      const { db, ownerExit, runner } = setup();
      ownerExit.exitAsOwner.mockRejectedValueOnce(new Error('broker 500'));
      db.alarms.push(supremeAlarm());
      await runner.pass(at(SUPREME_EXIT_AGENT_LOOK_MS));
      expect(db.alarms[0].payload?.exitPending).toBe(true);
      db.openTrackers.clear();
      await runner.pass(at(SUPREME_EXIT_AGENT_LOOK_MS + 15_000));
      expect(db.alarms[0].status).toBe('CLOSED');
      expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
    });

    it('agent EXIT_NOW agrees → no confirm, no owner-path exit (its own exit runs), marked pending on the executor', async () => {
      const { db, supreme, ownerExit, runner } = setup();
      db.alarms.push(supremeAlarm());
      db.verdicts.push({ id: 'v1', verdict: 'EXIT_NOW', createdAt: at(20_000), trackerId: 'trk1' });
      await runner.pass(at(30_000));
      expect(supreme.confirm).not.toHaveBeenCalled();
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
      expect(db.alarms[0].payload).toMatchObject({ roundTrip: true, awaitExecutor: true, exitPending: true, agentVerdictId: 'v1' });
    });

    describe('the agent agreed: its exit is followed until it fills (item 3)', () => {
      // The router answered the SUPREME_EXIT alarm EXIT_NOW (supreme asked) with the agent's verdict id.
      const agreed = () => supremeAlarm({ status: 'ANSWERED', answeredAt: at(20_000), answer: 'EXIT_NOW (supreme asked)', answerVerdictId: 'v1' });

      it('executor row FILLED → done, no owner-path exit, no confirm', async () => {
        const { db, ownerExit, supreme, runner } = setup();
        db.alarms.push(agreed());
        db.executions.set('v1', { status: 'FILLED', reason: null });
        await runner.pass(at(25_000));
        await runner.pass(at(200_000));
        expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
        expect(supreme.confirm).not.toHaveBeenCalled();
        expect(db.alarms[0].payload).toMatchObject({ awaitExecutor: false, exitPending: false, executor: 'FILLED' });
      });

      it('executor row CLAIMED / PLACED → waits (no exit)', async () => {
        for (const status of ['CLAIMED', 'PLACED']) {
          const { db, ownerExit, runner } = setup();
          db.alarms.push(agreed());
          db.executions.set('v1', { status, reason: null });
          await runner.pass(at(400_000));
          expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
        }
      });

      it.each([
        ['SKIPPED', 'USER_NOT_ENABLED'],
        ['DRY_RUN', 'would SELL 75 …'],
        ['SKIPPED', 'DAILY_CAP'],
        ['SKIPPED', 'STALE_VERDICT'],
        ['FAILED', 'BROKER_READ'],
        ['REJECTED', 'RMS'],
      ])('executor row %s %s → the supreme exit via the owner path (not owner-initiated) + the owner told', async (status, reason) => {
        const { db, ownerExit, supreme, telegram, runner } = setup();
        db.alarms.push(agreed());
        db.executions.set('v1', { status, reason });
        await runner.pass(at(25_000));
        expect(supreme.confirm).not.toHaveBeenCalled();
        expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
        expect(ownerExit.exitAsOwner.mock.calls[0][2]).toMatch(/^SUPREME_EXIT \(agent agreed, its exit not sent\): /);
        expect(ownerExit.exitAsOwner.mock.calls[0][3]).toEqual({ ownerInitiated: false });
        expect(telegram.sendMessage.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/agent agreed but its exit was not sent/);
        expect(db.alarms[0].status).toBe('CLOSED');
        await runner.pass(at(40_000));
        expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
      });

      it('no execution row at all: waits SUPREME_EXIT_AGENT_LOOK_MS after the agreement, then exits for the supreme', async () => {
        const { db, ownerExit, runner } = setup();
        db.alarms.push(supremeAlarm());
        db.verdicts.push({ id: 'v1', verdict: 'EXIT_NOW', createdAt: at(20_000), trackerId: 'trk1' });
        await runner.pass(at(30_000));
        await runner.pass(at(30_000 + SUPREME_EXIT_AGENT_LOOK_MS - 1));
        expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
        await runner.pass(at(30_000 + SUPREME_EXIT_AGENT_LOOK_MS));
        expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
      });

      it('the owner-path exit failing stays pending and is retried every pass', async () => {
        const { db, ownerExit, runner } = setup();
        ownerExit.exitAsOwner.mockRejectedValueOnce(new Error('broker 500'));
        db.alarms.push(agreed());
        db.executions.set('v1', { status: 'SKIPPED', reason: 'USER_NOT_ENABLED' });
        await runner.pass(at(25_000));
        expect(db.alarms[0].payload).toMatchObject({ exitPending: true, awaitExecutor: false });
        await runner.pass(at(40_000));
        expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(2);
        expect(db.alarms[0].status).toBe('CLOSED');
      });

      it('the trade closes while waiting → CLOSED, no exit', async () => {
        const { db, ownerExit, runner } = setup();
        db.alarms.push(agreed());
        db.openTrackers.clear();
        await runner.pass(at(400_000));
        expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
        expect(db.alarms[0].status).toBe('CLOSED');
      });
    });
  });

  describe('tick gate', () => {
    it('off (not live) → no pass', async () => {
      const { db, telegram, runner } = setup({ live: false });
      db.alarms.push(alarm({ raisedAt: new Date(Date.now() - 10 * 60_000) }));
      await runner.tick();
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('BOOT_JOBS=false → no pass', async () => {
      process.env.BOOT_JOBS = 'false';
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm({ raisedAt: new Date(Date.now() - 10 * 60_000) }));
      await runner.tick();
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('live + boot jobs → a pass runs', async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm({ raisedAt: new Date(Date.now() - 10 * 60_000) }));
      await runner.tick();
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * AUTHORITY DRILL (supreme fixes W5, 2026-11-28): a drill alarm (`payload.drill === true`) is observe-only in the runner —
 * never a backstop, never an owner-path exit, never Exit buttons. It is answered from the agent's verdict, the supreme is
 * asked once observe-only when the agent wanted out, the owner is told "DRILL", and the alarm is closed.
 */
describe('EscalationRunner.pass — authority drill (observe only, never sells)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  const drill = (over: Partial<AlarmRow> = {}) => alarm({ payload: { drill: true, raisedBy: 'authority-drill' }, ...over });
  const sentTexts = (telegram: { sendMessage: jest.Mock }) => telegram.sendMessage.mock.calls.map((c) => String(c[0]));

  it('HARD_LOSS drill, AI down, owner silent 11 min, still past the limit: NO backstop, NO exit', async () => {
    const { db, ownerExit, probe, runner } = setup({ aiDown: true });
    db.alarms.push(drill({ rule: 'HARD_LOSS', urgency: 'urgent', alertedAt: at(0), alertCount: 1 }));
    await runner.pass(at(BACKSTOP_OWNER_SILENT_MS + 60_000));
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    expect(probe.stillPastLimit).not.toHaveBeenCalled();
    expect(db.alarms[0].status).not.toBe('BACKSTOPPED');
  });

  it('a deadline drill at deadline − 2 min: NO deadline backstop', async () => {
    const { db, ownerExit, runner } = setup();
    db.alarms.push(drill({ urgency: 'deadline', deadline: at(DEADLINE_EXIT_LEAD_MS + 30_000) }));
    await runner.pass(at(60_000));
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    const answered = drill({ id: 'a2', urgency: 'deadline', deadline: at(DEADLINE_EXIT_LEAD_MS + 30_000), status: 'ANSWERED', answeredAt: at(10_000), answer: 'HOLD' });
    db.alarms.push(answered);
    await runner.pass(at(60_000));
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
  });

  it('a SUPREME_EXIT row flagged drill (never raised by the script) still never exits through the owner path', async () => {
    const { db, ownerExit, supreme, runner } = setup();
    db.alarms.push(drill({ rule: 'SUPREME_EXIT', urgency: 'urgent' }));
    await runner.pass(at(SUPREME_EXIT_AGENT_LOOK_MS + 60_000));
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    expect(supreme.confirm).not.toHaveBeenCalled();
  });

  it('unanswered past ESCALATE_AFTER: one DRILL message to the owner, with NO buttons; never repeated', async () => {
    const { db, telegram, runner } = setup();
    db.alarms.push(drill());
    await runner.pass(at(ESCALATE_AFTER_MS + 1));
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage.mock.calls[0][0]).toMatch(/^DRILL/);
    expect(telegram.sendMessage.mock.calls[0][1]).toBeUndefined();
    expect(db.alarms[0].alertedAt).toEqual(at(ESCALATE_AFTER_MS + 1));
    await runner.pass(at(ESCALATE_AFTER_MS + REALERT_EVERY_MS + 1));
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('the agent answered EXIT_ADVISORY: answered, the supreme asked ONCE observe-only, owner told DRILL, alarm CLOSED, nothing sold', async () => {
    const { db, alarms, telegram, ownerExit, supreme, runner } = setup({ confirm: 'CONFIRM' });
    db.alarms.push(drill());
    db.verdicts.push({ id: 'v-d', verdict: 'EXIT_ADVISORY', createdAt: at(20_000), trackerId: 'trk1' });
    await runner.pass(at(30_000));
    expect(alarms.answer).toHaveBeenCalledWith('a1', 'v-d', 'EXIT_ADVISORY', at(30_000));
    expect(supreme.confirm).toHaveBeenCalledTimes(1);
    expect(supreme.confirm.mock.calls[0][0]).toMatchObject({ trackerId: 'trk1', agentDecision: 'EXIT' });
    expect(supreme.confirm.mock.calls[0][0].packetSummary).toMatch(/DRILL/);
    expect(db.alarms[0].status).toBe('CLOSED');
    expect(db.alarms[0].payload).toMatchObject({ drill: true, drillConfirm: 'CONFIRM: supreme says go' });
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    const text = sentTexts(telegram).join('\n');
    expect(text).toMatch(/^DRILL/);
    expect(text).toMatch(/EXIT_ADVISORY/);
    expect(text).toMatch(/nothing (was )?sold/i);
    expect(telegram.sendMessage.mock.calls.every((c) => c[1] === undefined)).toBe(true);
    await runner.pass(at(60_000));
    expect(supreme.confirm).toHaveBeenCalledTimes(1);
  });

  it('the agent answered HOLD: answered, no supreme call, CLOSED, owner told DRILL', async () => {
    const { db, telegram, supreme, ownerExit, runner } = setup();
    db.alarms.push(drill());
    db.verdicts.push({ id: 'v-h', verdict: 'HOLD', createdAt: at(20_000), trackerId: 'trk1' });
    await runner.pass(at(30_000));
    expect(supreme.confirm).not.toHaveBeenCalled();
    expect(db.alarms[0].status).toBe('CLOSED');
    expect(sentTexts(telegram)[0]).toMatch(/^DRILL.*HOLD/s);
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
  });

  it('an EXIT_NOW answer (a real look seconds after the raise) is reported, never followed', async () => {
    const { db, supreme, ownerExit, runner } = setup({ confirm: 'OVERRIDE_HOLD' });
    db.alarms.push(drill());
    db.verdicts.push({ id: 'v-x', verdict: 'EXIT_NOW', createdAt: at(20_000), trackerId: 'trk1' });
    await runner.pass(at(30_000));
    expect(supreme.confirm).toHaveBeenCalledTimes(1);
    expect(db.alarms[0].payload).toMatchObject({ drillConfirm: 'OVERRIDE_HOLD: supreme says go' });
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
  });

  it('unanswered for 10 min: CLOSED and the owner told the agent never looked', async () => {
    const { db, telegram, ownerExit, runner } = setup();
    db.alarms.push(drill({ alertedAt: at(ESCALATE_AFTER_MS + 1), alertCount: 1 }));
    await runner.pass(at(10 * 60_000));
    expect(db.alarms[0].status).toBe('CLOSED');
    expect(sentTexts(telegram)[0]).toMatch(/^DRILL.*no agent look/s);
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
  });

  it('a real alarm beside it is handled exactly as before', async () => {
    const { db, alarms, runner } = setup();
    db.alarms.push(alarm({ id: 'real' }), drill({ id: 'd1' }));
    db.verdicts.push({ id: 'v1', verdict: 'HOLD', createdAt: at(20_000), trackerId: 'trk1' });
    await runner.pass(at(30_000));
    expect(alarms.answer).toHaveBeenCalledWith('real', 'v1', 'HOLD', at(30_000));
    expect(db.alarms.find((a) => a.id === 'real')!.status).toBe('ANSWERED');
  });
});
