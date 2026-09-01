import { connectWithRetry, connectAtBoot } from './prisma.service';

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

describe('connectAtBoot', () => {
  const makeLogger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

  it('never rejects when the database is unreachable, so the port can still bind', async () => {
    const boom = new Error("Can't reach database server");
    const logger = makeLogger();

    // The API must come up and serve /healthz/live with the database down.
    // Rethrowing here escaped `onModuleInit`, and because bootstrap() had no
    // catch, that became an unhandled rejection the process handler merely
    // LOGGED -- leaving a live process that never called listen(). Render then
    // reported "no open ports detected", which is a symptom four layers removed
    // from an unreachable database.
    await expect(
      connectAtBoot(jest.fn().mockRejectedValue(boom), logger, 2, 0),
    ).resolves.toBeUndefined();

    // Silence is what made this class of failure survive. Say it once, loudly.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain("Can't reach database server");
  });

  it('logs the connection once on success', async () => {
    const logger = makeLogger();

    await connectAtBoot(jest.fn().mockResolvedValue(undefined), logger, 5, 0);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
