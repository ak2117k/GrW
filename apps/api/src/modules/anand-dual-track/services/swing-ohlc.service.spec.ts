import { SwingOhlcService } from './swing-ohlc.service';

/**
 * Boot race (prod 2026-10-18): the boot backfill started before the shared feed
 * login landed and failed every swing entry with "Not authenticated" — 176 error
 * lines in 4 s. The run now waits for the session first, and stops at the first
 * auth failure instead of failing every remaining entry the same way.
 */
describe('SwingOhlcService session handling', () => {
  const entry = (id: string, symbol: string) => ({
    id,
    token: '123',
    symbol,
    enteredAt: new Date('2026-10-01T05:00:00Z'),
    exitedAt: null,
    status: 'TRADED',
  });

  function build(opts: { authed: boolean; historical: jest.Mock }) {
    const repo = {
      listAllSwingEntries: jest.fn().mockResolvedValue([entry('a', 'AAA'), entry('b', 'BBB'), entry('c', 'CCC')]),
      latestSwingOhlcDate: jest.fn().mockResolvedValue(null),
      countSwingPostExitRows: jest.fn().mockResolvedValue(0),
      upsertSwingDailyOhlc: jest.fn().mockResolvedValue(undefined),
    };
    const adapter = { getHistoricalData: opts.historical };
    const auth = { whenAuthenticated: jest.fn().mockResolvedValue(opts.authed) };
    const service = new SwingOhlcService(repo as any, adapter as any, auth as any);
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    return { service, repo, adapter, auth, warn };
  }

  it('skips the whole run with ONE warning when no session arrives', async () => {
    const { service, repo, adapter, warn } = build({ authed: false, historical: jest.fn() });

    await service.runForAllInWindow();

    expect(repo.listAllSwingEntries).not.toHaveBeenCalled();
    expect(adapter.getHistoricalData).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('no Angel One feed session');
  });

  it('runs every entry once the session is ready', async () => {
    const historical = jest.fn().mockResolvedValue([
      { timestamp: '2026-10-01T00:00:00+05:30', open: 1, high: 2, low: 0.5, close: 1.5 },
    ]);
    const { service, auth, warn } = build({ authed: true, historical });

    await service.runForAllInWindow();

    expect(auth.whenAuthenticated).toHaveBeenCalledTimes(1);
    expect(historical).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stops at the first "Not authenticated" failure instead of failing every entry', async () => {
    const historical = jest
      .fn()
      .mockRejectedValue(new Error('Get historical data failed: Not authenticated. Call login() first.'));
    const { service, warn } = build({ authed: true, historical });

    await service.runForAllInWindow();

    expect(historical).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('session lost at AAA');
  });

  it('still skips just the one entry on an ordinary broker error', async () => {
    const historical = jest
      .fn()
      .mockRejectedValueOnce(new Error('Access denied because of exceeding access rate'))
      .mockResolvedValue([]);
    const { service, warn } = build({ authed: true, historical });

    await service.runForAllInWindow();

    expect(historical).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('(AAA) skipped');
  });
});
