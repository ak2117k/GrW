import { connectWithRetry } from './prisma.service';

const silentLogger = { log: () => undefined, warn: () => undefined };

describe('connectWithRetry', () => {
  it('returns immediately when the first attempt succeeds', async () => {
    const connect = jest.fn().mockResolvedValue(undefined);
    await connectWithRetry(connect, silentLogger, 5, 0);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('survives a sleeping database — the case this exists for', async () => {
    // Serverless Postgres parks its compute when idle; the first connection
    // wakes it and times out doing so, and the next one succeeds. Without this
    // retry, every cold boot is a coin toss — and it does not fail as "asleep",
    // it fails as whichever service queried first.
    const connect = jest
      .fn()
      .mockRejectedValueOnce(new Error("Can't reach database server at ep-x.neon.tech:5432"))
      .mockRejectedValueOnce(new Error("Can't reach database server at ep-x.neon.tech:5432"))
      .mockResolvedValue(undefined);

    await connectWithRetry(connect, silentLogger, 5, 0);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('rethrows the LAST error untouched once attempts run out', async () => {
    // A genuinely wrong connection string must still surface as Prisma's own
    // error, not as a retry-wrapper message that hides it.
    const boom = new Error('Authentication failed against database server');
    const connect = jest.fn().mockRejectedValue(boom);

    await expect(connectWithRetry(connect, silentLogger, 3, 0)).rejects.toBe(boom);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('warns on each retry, so a slow boot is explained rather than mysterious', async () => {
    const warn = jest.fn();
    const connect = jest.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValue(undefined);

    await connectWithRetry(connect, { log: () => undefined, warn }, 5, 0);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/attempt 1\/5/);
  });
});
