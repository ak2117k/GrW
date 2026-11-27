import { Logger } from '@nestjs/common';
import type { AiHealthPort } from '../../ai-gateway/audit/failover-transport';
import {
  BACKSTOP_OWNER_SILENT_MS,
  DEADLINE_EXIT_LEAD_MS,
  ESCALATE_AFTER_MS,
  ESCALATE_URGENT_AFTER_MS,
  REALERT_EVERY_MS,
  SUPREME_EXIT_AGENT_LOOK_MS,
} from '../domain/timings';
import type { AlarmRow, ConfirmResult, SupremeConfirmPort, TradeAlarmsPort } from '../exit-authority.tokens';
import type { EscalationRepository } from '../repositories/escalation.repository';
import type { AgentVerdictRef, TradeAlarmPatch, TradeAlarmRepository } from '../repositories/trade-alarm.repository';
import type { TelegramBotClient } from '../telegram/telegram-bot.client';
import { TrackerMessages } from '../telegram/tracker-messages';
import { holdUntil } from '../telegram/owner-buttons.service';
import type { AuthorityStateService } from './authority-state.service';
import { EscalationRunner, type HardLossProbe, type OwnerExitPort } from './escalation-runner.service';

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

    it('REALERT → the same message is edited (no new one) and alertCount++, then every 5 min from the first alert', async () => {
      const { db, telegram, runner } = setup();
      db.alarms.push(alarm({ alertedAt: at(0), alertCount: 1, telegramMessageId: 55 }));
      await runner.pass(at(REALERT_EVERY_MS));
      expect(telegram.sendMessage).not.toHaveBeenCalled();
      expect(telegram.editMessage).toHaveBeenCalledTimes(1);
      expect(telegram.editMessage.mock.calls[0][0]).toBe(55);
      expect(db.alarms[0]).toMatchObject({ alertCount: 2, telegramMessageId: 55, alertedAt: at(0) });

      await runner.pass(at(REALERT_EVERY_MS + 15_000));
      expect(telegram.editMessage).toHaveBeenCalledTimes(1);
      await runner.pass(at(2 * REALERT_EVERY_MS));
      expect(telegram.editMessage).toHaveBeenCalledTimes(2);
      expect(db.alarms[0].alertCount).toBe(3);
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
    expect(telegram.editMessage).not.toHaveBeenCalled();

    await runner.pass(until); // snooze over: re-alert (on the trade's message), not a sale
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    expect(telegram.editMessage).toHaveBeenCalledTimes(1);
    expect(telegram.editMessage.mock.calls[0][0]).toBe(55);
    expect(db.alarms[0]).toMatchObject({ alertedAt: until, alertCount: 1 });

    await runner.pass(new Date(until.getTime() + BACKSTOP_OWNER_SILENT_MS - 1));
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    await runner.pass(new Date(until.getTime() + BACKSTOP_OWNER_SILENT_MS));
    expect(ownerExit.exitAsOwner.mock.calls[0][2]).toMatch(/^BACKSTOP HARD_LOSS: /);
  });

  it('one message per trade: two alarms on one tracker → one send + one edit (latest alarm id on the buttons)', async () => {
    const { db, telegram, runner } = setup();
    db.alarms.push(alarm());
    await runner.pass(at(ESCALATE_AFTER_MS));
    db.alarms.push(alarm({ id: 'a2', rule: 'LADDER', reason: 'ladder step lost', raisedAt: at(ESCALATE_AFTER_MS), lastRaisedAt: at(ESCALATE_AFTER_MS) }));
    await runner.pass(at(2 * ESCALATE_AFTER_MS));
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.editMessage).toHaveBeenCalledTimes(1);
    const [id, text, buttons] = telegram.editMessage.mock.calls[0];
    expect(id).toBe(101);
    expect(text).toContain('ladder step lost');
    expect(buttons).toEqual([
      [
        { text: 'Exit', data: 'x:a2' },
        { text: 'Hold', data: 'h:a2' },
      ],
    ]);
    expect(db.alarms.find((a) => a.id === 'a2')?.telegramMessageId).toBe(101);
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
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.editMessage).toHaveBeenCalledTimes(1);
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

    it('agent EXIT_NOW agrees → no confirm, no owner-path exit (its own exit runs), marked', async () => {
      const { db, supreme, ownerExit, runner } = setup();
      db.alarms.push(supremeAlarm());
      db.verdicts.push({ id: 'v1', verdict: 'EXIT_NOW', createdAt: at(20_000), trackerId: 'trk1' });
      await runner.pass(at(30_000));
      expect(supreme.confirm).not.toHaveBeenCalled();
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
      expect(db.alarms[0].payload?.roundTrip).toBe(true);
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
