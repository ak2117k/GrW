import { Logger } from '@nestjs/common';
import { OWNER_HOLD_SNOOZE_MS } from '../domain/timings';
import type { AlarmRow } from '../exit-authority.tokens';
import type { EscalationRepository, TrackerRef } from '../repositories/escalation.repository';
import type { TradeAlarmPatch, TradeAlarmRepository } from '../repositories/trade-alarm.repository';
import type { AuthorityStateService } from '../services/authority-state.service';
import type { OwnerExitPort } from '../services/escalation-runner.service';
import { OwnerButtonsService } from './owner-buttons.service';
import type { TelegramBotClient, TelegramCallbackQuery } from './telegram-bot.client';

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

function setup(opts: { ownerExit?: boolean; live?: boolean } = {}) {
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
  };
  const telegram = {
    chatId: () => CHAT,
    answerCallback: jest.fn(async (_id: string, _text?: string) => undefined),
    editMessage: jest.fn(async (_id: number, _text: string, _buttons?: unknown) => undefined),
    sendMessage: jest.fn(async (_text: string, _buttons?: unknown) => 9),
    getUpdates: jest.fn(),
  };
  const ownerExit: OwnerExitPort & { exitAsOwner: jest.Mock } = { exitAsOwner: jest.fn(async () => 'man_trk1_1') };
  const state = { isLive: () => opts.live ?? true, ready: Promise.resolve() } as unknown as AuthorityStateService;
  const svc = new OwnerButtonsService(
    telegram as unknown as TelegramBotClient,
    repo as unknown as TradeAlarmRepository,
    esc as unknown as EscalationRepository,
    state,
    opts.ownerExit === false ? undefined : ownerExit,
  );
  return { rows, trackers, repo, telegram, ownerExit, svc };
}

const tap = (data: string, chat: string | number = CHAT): TelegramCallbackQuery => ({
  id: 'cq1',
  data,
  from: { id: 1 },
  message: { message_id: 55, chat: { id: chat } },
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
    expect(ownerExit.exitAsOwner).toHaveBeenCalledWith('owner1', 'trk1', 'OWNER via Telegram');
    expect(rows[0].status).toBe('CLOSED');
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'Exit sent');
    expect(telegram.editMessage.mock.calls[0][0]).toBe(55);
    expect(String(telegram.editMessage.mock.calls[0][1])).toContain('Exit sent');
  });

  it('h:<id> → SNOOZED until now + OWNER_HOLD_SNOOZE_MS', async () => {
    const { rows, svc, telegram, ownerExit } = setup();
    rows.push(alarm());
    await svc.handleCallback(tap('h:a1'), NOW);
    expect(rows[0].status).toBe('SNOOZED');
    expect(rows[0].snoozedUntil).toEqual(new Date(NOW.getTime() + OWNER_HOLD_SNOOZE_MS));
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'Held 15 min');
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

    it('sends Exit / Hold keyed by tracker, at most once per execution row', async () => {
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
    });

    it('off (not live) → nothing sent', async () => {
      const { svc, telegram } = setup({ live: false });
      await svc.blockedExit(input);
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('bx:<tracker> → owner exit for the tracker owner; bh:<tracker> → held, later rows suppressed', async () => {
      const { svc, telegram, ownerExit } = setup();
      await svc.blockedExit(input);
      await svc.handleCallback(tap('bh:trk1'), new Date());
      expect(telegram.answerCallback).toHaveBeenCalledWith('cq1', 'Held: your order stays');
      await svc.blockedExit({ ...input, detail: 'execution aix_2' });
      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);

      await svc.handleCallback(tap('bx:trk1'), new Date());
      expect(ownerExit.exitAsOwner).toHaveBeenCalledWith('owner1', 'trk1', expect.stringMatching(/^OWNER via Telegram/));
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
