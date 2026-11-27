import { Logger } from '@nestjs/common';
import { DEADLINE_EXIT_LEAD_MS, OWNER_HOLD_SNOOZE_MS } from '../domain/timings';
import type { AlarmRow } from '../exit-authority.tokens';
import type { EscalationRepository, TrackerRef } from '../repositories/escalation.repository';
import type { TradeAlarmPatch, TradeAlarmRepository } from '../repositories/trade-alarm.repository';
import type { AuthorityStateService } from '../services/authority-state.service';
import type { OwnerExitPort } from '../services/escalation-runner.service';
import { OwnerButtonsService, holdUntil } from './owner-buttons.service';
import type { TelegramBotClient, TelegramCallbackQuery } from './telegram-bot.client';
import { TrackerMessages } from './tracker-messages';

const NOW = new Date('2026-11-27T06:00:00.000Z');
const CHAT = '-100777';

function alarm(over: Partial<AlarmRow> = {}): AlarmRow {
  return {
    id: 'a1',
    userId: 'owner1',
    trackerId: 'trk1',
    symbol: 'NIFTY25DEC26000CE',
    rule: 'HARD_LOSS',
    urgency: 'urgent',
    reason: 'past ₹2,000 hard loss',
    wouldHave: 'EXIT_NOW HARD_LOSS',
    deadline: null,
    severityN: 1,
    sourceRef: null,
    payload: undefined,
    status: 'OPEN',
    raisedAt: NOW,
    lastRaisedAt: NOW,
    answeredAt: null,
    answerVerdictId: null,
    answer: null,
    alertedAt: NOW,
    alertCount: 1,
    telegramMessageId: 55,
    snoozedUntil: null,
    ...over,
  };
}

function setup(opts: { ownerExit?: boolean; live?: boolean; ownerUserId?: string; trackerMessageId?: number | null } = {}) {
  const rows: AlarmRow[] = [];
  const trackers: TrackerRef[] = [{ id: 'trk1', userId: 'owner1', symbol: 'NIFTY25DEC26000CE', status: 'OPEN' }];
  const repo = {
    update: jest.fn(async (id: string, patch: TradeAlarmPatch) => {
      const r = rows.find((x) => x.id === id)!;
      Object.assign(r, patch);
      return { ...r };
    }),
  };
  const esc = {
    findById: jest.fn(async (id: string) => {
      const r = rows.find((x) => x.id === id);
      return r ? { ...r } : null;
    }),
    tracker: jest.fn(async (id: string) => trackers.find((t) => t.id === id) ?? null),
    trackerMessageId: jest.fn(async (_id: string) => opts.trackerMessageId ?? null),
    setTrackerMessageId: jest.fn(async (_trackerId: string, _messageId: number) => undefined),
  };
  let msgSeq = 8;
  const telegram = {
    chatId: () => CHAT,
    ownerUserId: () => opts.ownerUserId ?? '',
    answerCallback: jest.fn(async (_id: string, _text?: string) => undefined),
    editMessage: jest.fn(async (_id: number, _text: string, _buttons?: unknown) => undefined),
    sendMessage: jest.fn(async (_text: string, _buttons?: unknown) => ++msgSeq),
    deleteMessage: jest.fn(async (_id: number) => undefined),
    getUpdates: jest.fn(),
  };
  const ownerExit: OwnerExitPort & { exitAsOwner: jest.Mock } = { exitAsOwner: jest.fn(async () => 'man_trk1_1') };
  const state = { isLive: () => opts.live ?? true, ready: Promise.resolve() } as unknown as AuthorityStateService;
  const messages = new TrackerMessages();
  const svc = new OwnerButtonsService(
    telegram as unknown as TelegramBotClient,
    repo as unknown as TradeAlarmRepository,
    esc as unknown as EscalationRepository,
    state,
    messages,
    opts.ownerExit === false ? undefined : ownerExit,
  );
  return { rows, trackers, repo, esc, telegram, ownerExit, svc, messages };
}

const tap = (
  data: string,
  chat: string | number = CHAT,
  over: { chatType?: string; fromId?: number; date?: number; editDate?: number } = {},
): TelegramCallbackQuery => ({
  id: 'cq1',
  data,
  from: { id: over.fromId ?? 1 },
  message: {
    message_id: 55,
    chat: { id: chat, type: over.chatType ?? 'private' },
    date: over.date ?? Math.floor(NOW.getTime() / 1000) - 60,
    ...(over.editDate != null ? { edit_date: over.editDate } : {}),
  },
});

describe('OwnerButtonsService', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a tap from a different chat → ignored and answered "not allowed"', async () => {
    const { rows, svc, telegram, ownerExit, repo } = setup();
    rows.push(alarm());
    await svc.handleCallback(tap('x:a1', -999), NOW);
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'not allowed');
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('x:<id> on an OPEN alarm → owner exit "OWNER via Telegram", CLOSED, message edited to "Exit sent"', async () => {
    const { rows, svc, telegram, ownerExit } = setup();
    rows.push(alarm());
    await svc.handleCallback(tap('x:a1'), NOW);
    // The owner's own tap is owner-initiated (owner ruling 2026-11-27: only it may cancel the owner's orders).
    expect(ownerExit.exitAsOwner).toHaveBeenCalledWith('owner1', 'trk1', 'OWNER via Telegram', { ownerInitiated: true });
    expect(rows[0].status).toBe('CLOSED');
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'Exit sent');
    expect(telegram.editMessage.mock.calls[0][0]).toBe(55);
    expect(String(telegram.editMessage.mock.calls[0][1])).toContain('Exit sent');
  });

  it('h:<id> → SNOOZED until now + OWNER_HOLD_SNOOZE_MS, and the owner-silence clock restarts', async () => {
    const { rows, svc, telegram, ownerExit } = setup();
    rows.push(alarm({ alertedAt: new Date(NOW.getTime() - 9 * 60_000), alertCount: 2 }));
    await svc.handleCallback(tap('h:a1'), NOW);
    expect(rows[0].status).toBe('SNOOZED');
    expect(rows[0].snoozedUntil).toEqual(new Date(NOW.getTime() + OWNER_HOLD_SNOOZE_MS));
    expect(rows[0]).toMatchObject({ alertedAt: null, alertCount: 0 });
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', expect.stringMatching(/^Held until /));
  });

  it('Hold on a deadline alarm is capped at deadline − DEADLINE_EXIT_LEAD_MS', async () => {
    const { rows, svc } = setup();
    const deadline = new Date(NOW.getTime() + 8 * 60_000); // DEADLINE_WARN window: 15 min would pass the deadline
    rows.push(alarm({ rule: 'CARRY', urgency: 'deadline', deadline }));
    await svc.handleCallback(tap('h:a1'), NOW);
    expect(rows[0].snoozedUntil).toEqual(new Date(deadline.getTime() - DEADLINE_EXIT_LEAD_MS));
    expect(holdUntil({ urgency: 'deadline', deadline: new Date(NOW.getTime() + 60 * 60_000) }, NOW)).toEqual(
      new Date(NOW.getTime() + OWNER_HOLD_SNOOZE_MS),
    );
  });

  describe('stale taps never sell', () => {
    it('x:<id> on a message last sent/edited > 30 min ago → "expired — use the app", no exit', async () => {
      const { rows, svc, telegram, ownerExit } = setup();
      rows.push(alarm());
      await svc.handleCallback(tap('x:a1', CHAT, { date: Math.floor(NOW.getTime() / 1000) - 31 * 60 }), NOW);
      expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'expired — use the app');
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
      expect(rows[0].status).toBe('OPEN');
    });

    it('bx:<tracker> on an old message → refused', async () => {
      const { svc, telegram, ownerExit } = setup();
      await svc.handleCallback(tap('bx:trk1', CHAT, { date: Math.floor(NOW.getTime() / 1000) - 3600 }), NOW);
      expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'expired — use the app');
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    });

    it('an old message re-alerted (edited) recently is still live', async () => {
      const { rows, svc, ownerExit } = setup();
      rows.push(alarm());
      const sec = Math.floor(NOW.getTime() / 1000);
      await svc.handleCallback(tap('x:a1', CHAT, { date: sec - 3600, editDate: sec - 120 }), NOW);
      expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
    });

    it('a message with no date → refused', async () => {
      const { rows, svc, ownerExit } = setup();
      rows.push(alarm());
      const cq = tap('x:a1');
      delete cq.message!.date;
      await svc.handleCallback(cq, NOW);
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    });
  });

  describe('who may tap', () => {
    it('TELEGRAM_ALERT_OWNER_USER_ID set: a different from.id → "not allowed"; the owner → acts', async () => {
      const { rows, svc, telegram, ownerExit } = setup({ ownerUserId: '4242' });
      rows.push(alarm());
      await svc.handleCallback(tap('x:a1', CHAT, { chatType: 'group', fromId: 1 }), NOW);
      expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'not allowed');
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
      await svc.handleCallback(tap('x:a1', CHAT, { chatType: 'group', fromId: 4242 }), NOW);
      expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
    });

    it('owner user id unset: a group chat is refused (anyone in it could tap)', async () => {
      const { rows, svc, telegram, ownerExit, repo } = setup();
      rows.push(alarm());
      await svc.handleCallback(tap('h:a1', CHAT, { chatType: 'supergroup' }), NOW);
      expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'not allowed');
      expect(repo.update).not.toHaveBeenCalled();
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    });
  });

  it.each(['ANSWERED', 'CLOSED', 'BACKSTOPPED'] as const)('a tap on a %s alarm → "already handled", no action', async (status) => {
    const { rows, svc, telegram, ownerExit, repo } = setup();
    rows.push(alarm({ status }));
    await svc.handleCallback(tap('x:a1'), NOW);
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'already handled');
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('a tap on an unknown alarm (replayed / old) → "already handled"', async () => {
    const { svc, telegram, ownerExit } = setup();
    await svc.handleCallback(tap('h:nope'), NOW);
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'already handled');
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
  });

  it('Exit with OWNER_EXIT absent → ERROR + a Telegram line; the alarm stays open', async () => {
    const { rows, svc, telegram } = setup({ ownerExit: false });
    rows.push(alarm());
    await svc.handleCallback(tap('x:a1'), NOW);
    expect(rows[0].status).toBe('OPEN');
    expect(errorSpy).toHaveBeenCalled();
    expect(String(telegram.sendMessage.mock.calls[0][0])).toMatch(/could NOT be sent/);
  });

  it('a failed exit keeps the alarm open and tells the owner', async () => {
    const { rows, svc, telegram, ownerExit } = setup();
    ownerExit.exitAsOwner.mockRejectedValueOnce(new Error('TRACKER_CLOSED'));
    rows.push(alarm());
    await svc.handleCallback(tap('x:a1'), NOW);
    expect(rows[0].status).toBe('OPEN');
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'Exit FAILED: use the app');
  });

  describe('blockedExit', () => {
    const input = { userId: 'owner1', trackerId: 'trk1', symbol: 'SENSEX25DEC85000PE', reason: 'OPEN_ORDER_EXISTS', detail: 'execution aix_1: resting SL order 1234' };

    it('sends Exit / Hold keyed by tracker, at most once per execution row; a new row sends fresh + deletes the old', async () => {
      const { svc, telegram } = setup();
      await svc.blockedExit(input);
      await svc.blockedExit(input);
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
      expect(telegram.sendMessage.mock.calls[0][1]).toEqual([
        [
          { text: 'Exit', data: 'bx:trk1' },
          { text: 'Hold', data: 'bh:trk1' },
        ],
      ]);
      await svc.blockedExit({ ...input, detail: 'execution aix_2: resting SL order 1234' });
      expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
      expect(telegram.deleteMessage).toHaveBeenCalledWith(9);
      expect(telegram.editMessage).not.toHaveBeenCalled();
    });

    it("replaces the trade's existing alarm message (fresh send, delete old) and persists the new id on the alarm rows", async () => {
      const { svc, telegram, messages, esc } = setup({ trackerMessageId: 77 });
      await svc.blockedExit(input);
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
      expect(telegram.deleteMessage).toHaveBeenCalledWith(77);
      expect(messages.get('trk1')).toBe(9);
      expect(esc.setTrackerMessageId).toHaveBeenCalledWith('trk1', 9);
    });

    it('the persisted id (another container) wins over memory', async () => {
      const { svc, telegram, messages } = setup({ trackerMessageId: 77 });
      messages.set('trk1', 5); // stale in this process
      await svc.blockedExit(input);
      expect(telegram.deleteMessage).toHaveBeenCalledWith(77);
      expect(telegram.deleteMessage).not.toHaveBeenCalledWith(5);
    });

    it('a failed delete is ignored', async () => {
      const { svc, telegram, messages } = setup({ trackerMessageId: 77 });
      telegram.deleteMessage.mockRejectedValueOnce(new Error('message to delete not found'));
      await expect(svc.blockedExit(input)).resolves.toBeUndefined();
      expect(messages.get('trk1')).toBe(9);
    });

    it('off (not live) → nothing sent', async () => {
      const { svc, telegram } = setup({ live: false });
      await svc.blockedExit(input);
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('bx:<tracker> → owner exit for the tracker owner; bh:<tracker> → held, later rows suppressed', async () => {
      const { svc, telegram, ownerExit } = setup();
      await svc.blockedExit(input);
      await svc.handleCallback(tap('bh:trk1', CHAT, { date: Math.floor(Date.now() / 1000) }), new Date());
      expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'Held: your order stays');
      await svc.blockedExit({ ...input, detail: 'execution aix_2' });
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
      expect(telegram.editMessage).toHaveBeenCalledTimes(1); // only the Hold confirmation edit

      await svc.handleCallback(tap('bx:trk1', CHAT, { date: Math.floor(Date.now() / 1000) }), new Date());
      expect(ownerExit.exitAsOwner).toHaveBeenCalledWith('owner1', 'trk1', expect.stringMatching(/^OWNER via Telegram/), { ownerInitiated: true });
    });

    it('bx on a closed tracker → "already handled"', async () => {
      const { svc, telegram, trackers, ownerExit } = setup();
      trackers[0].status = 'CLOSED';
      await svc.handleCallback(tap('bx:trk1'), NOW);
      expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'already handled');
      expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    });
  });

  it('pollOnce advances the offset and handles callback queries', async () => {
    const { rows, svc, telegram } = setup();
    rows.push(alarm());
    telegram.getUpdates
      .mockResolvedValueOnce([{ update_id: 10, callback_query: tap('h:a1') }, { update_id: 11 }])
      .mockResolvedValueOnce([]);
    await svc.pollOnce(NOW);
    expect(telegram.getUpdates).toHaveBeenLastCalledWith(0, 25);
    expect(rows[0].status).toBe('SNOOZED');
    await svc.pollOnce(NOW);
    expect(telegram.getUpdates).toHaveBeenLastCalledWith(12, 25);
  });

  it('BOOT_JOBS=false → no polling', async () => {
    process.env.BOOT_JOBS = 'false';
    try {
      const { svc, telegram } = setup();
      svc.onApplicationBootstrap();
      await new Promise((r) => setImmediate(r));
      expect(telegram.getUpdates).not.toHaveBeenCalled();
    } finally {
      delete process.env.BOOT_JOBS;
    }
  });

  it('not live → no polling', async () => {
    const { svc, telegram } = setup({ live: false });
    svc.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(telegram.getUpdates).not.toHaveBeenCalled();
  });
});
