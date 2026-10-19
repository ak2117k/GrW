import { __resetOpsAlerts, OPS_ALERT_COOLDOWN_MS, sendOpsAlert } from './ops-alert';

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
