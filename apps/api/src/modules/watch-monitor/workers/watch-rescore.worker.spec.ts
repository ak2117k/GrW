import { WatchRescoreWorker } from './watch-rescore.worker';

/**
 * These queue calls await Redis. The existing guard here handles a REJECTION —
 * it was added so a transient Redis failure could not abort bootstrap — but not
 * a HANG, which is the more common shape when a host is unreachable rather than
 * refusing: ioredis keeps retrying and the promise simply never settles.
 *
 * Awaited in `onModuleInit`, that holds the port shut, because Nest awaits every
 * boot hook before `app.listen()`. Render then reports "no open ports detected"
 * and fails the deploy. The same hazard was already fixed once in the market
 * feed (an unreachable Redis must not hang the boot before the port binds);
 * this worker kept doing it.
 *
 * Registering a repeatable job is background work by definition. It must run
 * behind an already-listening server.
 */
describe('WatchRescoreWorker boot hook', () => {
  const monitor = {} as any;

  it('returns without waiting for Redis, so the port can bind', async () => {
    // A hung Redis, not a failing one: the promise never settles.
    const queue = {
      getRepeatableJobs: jest.fn().mockReturnValue(new Promise(() => {})),
      removeRepeatableByKey: jest.fn(),
      add: jest.fn(),
    } as any;

    const outcome = await Promise.race([
      Promise.resolve(new WatchRescoreWorker(queue, monitor).onModuleInit()).then(
        () => 'hook settled',
      ),
      new Promise((resolve) => {
        setTimeout(() => resolve('hook blocked on Redis'), 100).unref();
      }),
    ]);

    expect(outcome).toBe('hook settled');
  });

  it('still registers the repeatable job, just not in front of the port', async () => {
    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([{ name: 'tick', key: 'tick-key' }]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
    } as any;

    new WatchRescoreWorker(queue, monitor).onModuleInit();
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // The stale repeatable is cleared before the new one is added, so a changed
    // interval cannot leave two schedules running.
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('tick-key');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('does not touch Redis at all when boot jobs are disabled', async () => {
    const queue = { getRepeatableJobs: jest.fn(), removeRepeatableByKey: jest.fn(), add: jest.fn() } as any;
    process.env.BOOT_JOBS = 'false';
    try {
      new WatchRescoreWorker(queue, monitor).onModuleInit();
      await new Promise((resolve) => setImmediate(resolve));
      expect(queue.getRepeatableJobs).not.toHaveBeenCalled();
    } finally {
      delete process.env.BOOT_JOBS;
    }
  });
});
