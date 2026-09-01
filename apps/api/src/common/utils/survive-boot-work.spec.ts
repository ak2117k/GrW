import { surviveBootWork } from './survive-boot-work';

describe('surviveBootWork', () => {
  it('swallows a failure so a boot hook cannot abort bootstrap', async () => {
    const logger = { error: jest.fn() };

    await expect(
      surviveBootWork('seed the widget', async () => {
        throw new Error("Can't reach database server");
      }, logger),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('names the work and the cause, because silence is the failure mode', async () => {
    const logger = { error: jest.fn() };

    await surviveBootWork('seed the widget', async () => {
      throw new Error('P1001: unreachable\n  at somewhere');
    }, logger);

    const message = logger.error.mock.calls[0][0] as string;
    expect(message).toContain('seed the widget');
    expect(message).toContain('P1001: unreachable');
    // First line only — a boot log with five multi-line Prisma stacks in it is
    // one nobody reads, which is how these failures stayed invisible.
    expect(message).not.toContain('at somewhere');
  });

  it('stays out of the way when the work succeeds', async () => {
    const logger = { error: jest.fn() };
    const work = jest.fn().mockResolvedValue(undefined);

    await surviveBootWork('seed the widget', work, logger);

    expect(work).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
