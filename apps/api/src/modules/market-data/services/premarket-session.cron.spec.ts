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
});
