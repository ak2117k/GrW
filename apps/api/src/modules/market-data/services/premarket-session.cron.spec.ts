import { PremarketSessionCron } from './premarket-session.cron';

describe('PremarketSessionCron', () => {
  it('reLogin() calls authService.login() and returns true on success', async () => {
    const auth = { login: jest.fn().mockResolvedValue(undefined) };
    const cron = new PremarketSessionCron(auth as never);
    await expect(cron.reLogin()).resolves.toBe(true);
    expect(auth.login).toHaveBeenCalledTimes(1);
  });

  it('reLogin() swallows login errors and returns false (never throws — a failed pre-market login must not crash the scheduler)', async () => {
    const auth = { login: jest.fn().mockRejectedValue(new Error('boom')) };
    const cron = new PremarketSessionCron(auth as never);
    await expect(cron.reLogin()).resolves.toBe(false);
    expect(auth.login).toHaveBeenCalledTimes(1);
  });

  it('the @Cron handler refreshPremarketSession() delegates to reLogin() (login is invoked)', async () => {
    const auth = { login: jest.fn().mockResolvedValue(undefined) };
    const cron = new PremarketSessionCron(auth as never);
    await expect(cron.refreshPremarketSession()).resolves.toBeUndefined();
    expect(auth.login).toHaveBeenCalledTimes(1);
  });

  it('then re-logs in every per-user feed session, AFTER the shared one', async () => {
    const order: string[] = [];
    const auth = { login: jest.fn(async () => { order.push('shared'); }) };
    const feeds = { reloginAll: jest.fn(async () => { order.push('per-user'); return { ok: 1, failed: 0 }; }) };
    const cron = new PremarketSessionCron(auth as never, feeds as never);
    await cron.refreshPremarketSession();
    expect(order).toEqual(['shared', 'per-user']);
  });

  it('a per-user refresh fault never throws out of the scheduler', async () => {
    const auth = { login: jest.fn().mockResolvedValue(undefined) };
    const feeds = { reloginAll: jest.fn().mockRejectedValue(new Error('vault down')) };
    const cron = new PremarketSessionCron(auth as never, feeds as never);
    await expect(cron.refreshPremarketSession()).resolves.toBeUndefined();
  });
});
