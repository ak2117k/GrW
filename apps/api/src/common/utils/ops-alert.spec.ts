import { Logger } from '@nestjs/common';
import { __resetOpsAlerts, OPS_ALERT_COOLDOWN_MS, sendOpsAlert } from './ops-alert';
import { setTelegramOutboxRecorder, type TelegramOutboxRow } from './telegram-outbox';

describe('sendOpsAlert', () => {
  const env = { TELEGRAM_ALERT_BOT_TOKEN: 'secret-token', TELEGRAM_ALERT_CHAT_ID: '42' };
  beforeEach(() => __resetOpsAlerts());

  it('is a no-op when the bot is not configured', async () => {
    const fetch = jest.fn();
    await expect(sendOpsAlert('k', 'hi', { env: {}, fetch })).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts to the bot and sends each key at most once per cooldown', async () => {
    let now = 1_000_000;
    const fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    await expect(sendOpsAlert('k', 'one', { env, fetch, now: () => now })).resolves.toBe(true);
    await expect(sendOpsAlert('k', 'two', { env, fetch, now: () => now })).resolves.toBe(false);
    await expect(sendOpsAlert('other', 'x', { env, fetch, now: () => now })).resolves.toBe(true);
    now += OPS_ALERT_COOLDOWN_MS;
    await expect(sendOpsAlert('k', 'three', { env, fetch, now: () => now })).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://api.telegram.org/botsecret-token/sendMessage');
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: '42', text: 'one' });
  });

  it('never throws, and never logs the token, when the send fails', async () => {
    const warn = jest.spyOn((await import('@nestjs/common')).Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND api.telegram.org secret-token'); });
    await expect(sendOpsAlert('k', 'hi', { env, fetch })).resolves.toBe(false);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-token');
    warn.mockRestore();
  });
});

describe('sendOpsAlert records every send attempt in the outbox', () => {
  const env = { TELEGRAM_ALERT_BOT_TOKEN: 'secret-token', TELEGRAM_ALERT_CHAT_ID: '42' };
  let rows: TelegramOutboxRow[];
  beforeEach(() => {
    __resetOpsAlerts();
    rows = [];
    setTelegramOutboxRecorder((r) => { rows.push(r); });
  });
  afterEach(() => setTelegramOutboxRecorder(null));

  it('a delivered alert: ok, key as source, chat, short text and the message_id', async () => {
    const fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 913 } }) }));
    await expect(sendOpsAlert('DESK_RUN_FAILED', `desk down ${'y'.repeat(800)}`, { env, fetch })).resolves.toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ops', source: 'DESK_RUN_FAILED', method: 'sendMessage', chatId: '42', ok: true, error: null, messageId: 913 });
    expect(rows[0].text.startsWith('desk down')).toBe(true);
    expect(rows[0].text.length).toBe(500);
    expect(JSON.stringify(rows)).not.toContain('secret-token');
  });

  it('an HTTP error and a network error are recorded as failures, without the token', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const http = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) }));
    await sendOpsAlert('a', 'one', { env, fetch: http });
    const net = jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND botsecret-token'); });
    await sendOpsAlert('b', 'two', { env, fetch: net });
    expect(rows.map((r) => [r.source, r.ok, r.messageId])).toEqual([['a', false, null], ['b', false, null]]);
    expect(rows[0].error).toMatch(/HTTP 400.*chat not found/);
    expect(rows[1].error).toMatch(/Error/);
    expect(JSON.stringify(rows)).not.toContain('secret-token');
    warn.mockRestore();
  });

  it('an unconfigured bot is recorded as NOT SENT; a cooldown repeat is not an attempt', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await sendOpsAlert('c', 'lost', { env: {}, fetch: jest.fn() as never, now: () => 1 });
    await sendOpsAlert('c', 'lost', { env: {}, fetch: jest.fn() as never, now: () => 2 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'c', ok: false, chatId: '', error: 'not configured' });
    warn.mockRestore();
  });

  it('a failing outbox write never fails or delays the send', async () => {
    setTelegramOutboxRecorder(() => new Promise(() => undefined)); // never settles
    const fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    await expect(sendOpsAlert('d', 'x', { env, fetch })).resolves.toBe(true);
    setTelegramOutboxRecorder(() => { throw new Error('db down'); });
    await expect(sendOpsAlert('e', 'x', { env, fetch })).resolves.toBe(true);
  });
});

describe('sendOpsAlert when the bot is not configured', () => {
  it('logs what it could not send, once per cooldown', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.fn();
    const key = 'UNCONFIGURED_WARN_TEST';
    expect(await sendOpsAlert(key, 'the judge is down', { env: {}, fetch: fetch as never, now: () => 1_000 })).toBe(false);
    expect(await sendOpsAlert(key, 'the judge is down', { env: {}, fetch: fetch as never, now: () => 2_000 })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NOT SENT.*the judge is down/s));
    expect(fetch).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
