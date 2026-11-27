import { Logger } from '@nestjs/common';
import type { TelegramBotClient } from '../telegram/telegram-bot.client';
import { AuthorityStateService } from './authority-state.service';

const FULL = { TRADE_AGENT_AUTHORITY: 'live', TELEGRAM_ALERT_BOT_TOKEN: 'tok', TELEGRAM_ALERT_CHAT_ID: '-1' };

function setup(env: Record<string, string | undefined>, send: jest.Mock = jest.fn().mockResolvedValue(1)) {
  const telegram = { sendMessage: send } as unknown as TelegramBotClient;
  const svc = new AuthorityStateService(telegram, env);
  return { svc, send };
}

describe('AuthorityStateService (boot check)', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('live + both env vars + a successful test send → isLive() true, and false until the check completes', async () => {
    let release!: (v: number) => void;
    const send = jest.fn().mockReturnValue(new Promise<number>((r) => (release = r)));
    const { svc } = setup(FULL, send);
    expect(svc.isLive()).toBe(false);
    svc.onModuleInit();
    expect(svc.isLive()).toBe(false);
    release(9);
    await svc.ready;
    expect(svc.isLive()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a missing token → false, with the refused ERROR', async () => {
    const { svc, send } = setup({ ...FULL, TELEGRAM_ALERT_BOT_TOKEN: '' });
    svc.onModuleInit();
    await svc.ready;
    expect(svc.isLive()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/TRADE_AGENT_AUTHORITY=live refused: TELEGRAM_ALERT_BOT_TOKEN missing/)]),
    );
  });

  it('a missing chat id → false', async () => {
    const { svc } = setup({ ...FULL, TELEGRAM_ALERT_CHAT_ID: undefined });
    svc.onModuleInit();
    await svc.ready;
    expect(svc.isLive()).toBe(false);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/refused: TELEGRAM_ALERT_CHAT_ID missing/);
  });

  it('a send failure → false', async () => {
    const { svc } = setup(FULL, jest.fn().mockRejectedValue(new Error('sendMessage failed: HTTP 401 Unauthorized')));
    svc.onModuleInit();
    await svc.ready;
    expect(svc.isLive()).toBe(false);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/TRADE_AGENT_AUTHORITY=live refused: Telegram test message failed/);
  });

  it.each([{}, { TRADE_AGENT_AUTHORITY: 'off' }, { TRADE_AGENT_AUTHORITY: 'yes' }])(
    'off (%j) → false, and no send is attempted',
    async (env) => {
      const { svc, send } = setup({ ...env, TELEGRAM_ALERT_BOT_TOKEN: 'tok', TELEGRAM_ALERT_CHAT_ID: '-1' });
      svc.onModuleInit();
      await svc.ready;
      expect(svc.isLive()).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );
});
