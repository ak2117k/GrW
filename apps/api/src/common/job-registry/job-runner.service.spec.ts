import { JobRunnerService } from './job-runner.service';

function makeDeps(leaseAcquired = true) {
  const lease = {
    runExclusive: jest.fn(async (_name: string, _ttl: number, fn: () => Promise<unknown>) =>
      leaseAcquired ? await fn() : null,
    ),
  };
  // `order` records the sequence of repository calls, so the specs can pin that
  // the retention sweep happens AFTER the outcome is recorded rather than merely
  // that both happened.
  const order: string[] = [];
  const repo = {
    recordStart: jest.fn().mockResolvedValue('row-1'),
    recordEnd: jest.fn(async () => {
      order.push('recordEnd');
    }),
    recordSkipped: jest.fn(async () => {
      order.push('recordSkipped');
    }),
    maybePrune: jest.fn(async () => {
      order.push('maybePrune');
      return 0;
    }),
  };
  return { lease, repo, order };
}

describe('JobRunnerService', () => {
  it('records SUCCESS and returns the job result', async () => {
    const { lease, repo } = makeDeps();
    const runner = new JobRunnerService(lease as never, repo as never);
    const result = await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => 42);
    expect(result).toBe(42);
    expect(repo.recordStart).toHaveBeenCalledWith('reconcile');
    expect(repo.recordEnd).toHaveBeenCalledWith('row-1', 'SUCCESS', undefined);
  });

  it('records FAILED and rethrows when the job throws', async () => {
    const { lease, repo } = makeDeps();
    const runner = new JobRunnerService(lease as never, repo as never);
    const boom = new Error('boom');
    await expect(
      runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => {
        throw boom;
      }),
    ).rejects.toThrow('boom');
    expect(repo.recordEnd).toHaveBeenCalledWith('row-1', 'FAILED', boom);
  });

  it('records SKIPPED_LEASE and does not open a run row when the lease is held', async () => {
    const { lease, repo } = makeDeps(false);
    const runner = new JobRunnerService(lease as never, repo as never);
    const result = await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => 42);
    expect(result).toBeNull();
    expect(repo.recordSkipped).toHaveBeenCalledWith('reconcile');
    expect(repo.recordStart).not.toHaveBeenCalled();
  });

  /**
   * The other half of the `entered` flag, and the half a `result === null`
   * shortcut would silently get wrong: `runExclusive` also returns null when the
   * job RAN and legitimately returned null. Recording that as SKIPPED_LEASE
   * would put a false entry in the very table that exists to be trusted.
   */
  it('records SUCCESS, not SKIPPED_LEASE, when the job itself returns null', async () => {
    const { lease, repo } = makeDeps();
    const runner = new JobRunnerService(lease as never, repo as never);
    const result = await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => null);
    expect(result).toBeNull();
    expect(repo.recordSkipped).not.toHaveBeenCalled();
    expect(repo.recordEnd).toHaveBeenCalledWith('row-1', 'SUCCESS', undefined);
  });

  /**
   * Recording must never gate execution. `recordStart` returns null when its
   * own insert failed (it swallows, by design), and a null id must mean only
   * "this run will not be recorded" — never "this run does not happen". An
   * early return on a missing id would let a Neon wake-up stop every scheduled
   * job on the platform while CI stayed green: the observability layer becoming
   * the thing that halts the system it observes.
   */
  it('runs the job anyway when the start row could not be recorded', async () => {
    const { lease, repo } = makeDeps();
    repo.recordStart.mockResolvedValue(null);
    const runner = new JobRunnerService(lease as never, repo as never);
    const fn = jest.fn(async () => 42);
    const result = await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, fn);
    expect(fn).toHaveBeenCalled();
    expect(result).toBe(42);
    expect(repo.recordEnd).toHaveBeenCalledWith(null, 'SUCCESS', undefined);
  });

  /**
   * Retention has no cron of its own — deliberately, since a cron that stops
   * firing is the failure this whole table exists to expose. It rides the write
   * path instead, so the write path must actually call it.
   */
  it('sweeps retention after recording a successful end', async () => {
    const { lease, repo, order } = makeDeps();
    const runner = new JobRunnerService(lease as never, repo as never);
    await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => 42);
    expect(repo.maybePrune).toHaveBeenCalledTimes(1);
    expect(repo.maybePrune).toHaveBeenCalledWith(expect.any(Date));
    expect(order).toEqual(['recordEnd', 'maybePrune']);
  });

  /**
   * The sweep must NOT be success-only. A deployment where every tick fails
   * still writes a RUNNING row and a FAILED row per tick, so a success-only
   * sweep would stop pruning in precisely the state that grows the table
   * fastest — and one that is likely to persist unnoticed.
   */
  it('sweeps retention after recording a failed end, and rethrows unchanged', async () => {
    const { lease, repo, order } = makeDeps();
    const runner = new JobRunnerService(lease as never, repo as never);
    const boom = new Error('boom');
    await expect(
      runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(order).toEqual(['recordEnd', 'maybePrune']);
  });

  it('sweeps retention after recording a lease skip', async () => {
    const { lease, repo, order } = makeDeps(false);
    const runner = new JobRunnerService(lease as never, repo as never);
    await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => 42);
    expect(repo.maybePrune).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['recordSkipped', 'maybePrune']);
  });

  /**
   * The sweep is fire-and-forget. A never-settling prune — Neon mid-wake-up,
   * a hung connection — must not hold the job's result hostage. If an `await`
   * is ever added in front of `maybePrune`, this test hangs and fails, which is
   * precisely the production symptom it stands in for.
   */
  it('returns without waiting for the prune to settle', async () => {
    const { lease, repo } = makeDeps();
    repo.maybePrune.mockReturnValue(new Promise<number>(() => undefined));
    const runner = new JobRunnerService(lease as never, repo as never);
    const result = await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => 42);
    expect(result).toBe(42);
  });

  it('rethrows the job error without waiting for the prune to settle', async () => {
    const { lease, repo } = makeDeps();
    repo.maybePrune.mockReturnValue(new Promise<number>(() => undefined));
    const runner = new JobRunnerService(lease as never, repo as never);
    const boom = new Error('boom');
    await expect(
      runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  /**
   * A `void`ed rejection terminates the Node process by default, so the sweep
   * carries a rejection handler at the call site IN ADDITION to `maybePrune`'s
   * own internal no-reject guarantee. The two are not duplication: the guarantee
   * holds today (pinned in job-run.retention.spec.ts), the handler bounds the
   * blast radius if a later edit breaks it.
   *
   * Asserted structurally — that a handler is attached — because the
   * behavioural alternative is to actually emit an unhandled rejection and
   * assert the process did not die, which is neither expressible nor safe
   * inside the test runner's own process.
   */
  it('attaches a rejection handler to the fire-and-forget sweep', async () => {
    const { lease, repo } = makeDeps();
    const sweep = Promise.resolve(0);
    const onRejected = jest.spyOn(sweep, 'catch');
    repo.maybePrune.mockReturnValue(sweep);
    const runner = new JobRunnerService(lease as never, repo as never);
    await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => 42);
    expect(onRejected).toHaveBeenCalledWith(expect.any(Function));
  });

  it('survives a sweep that rejects, returning the job result unchanged', async () => {
    const { lease, repo } = makeDeps();
    repo.maybePrune.mockRejectedValue(new Error('prune boom'));
    const runner = new JobRunnerService(lease as never, repo as never);
    const result = await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => 42);
    expect(result).toBe(42);
  });

  /** A rejecting sweep must not replace the job's own error. */
  it('rethrows the job error, not the sweep error, when both fail', async () => {
    const { lease, repo } = makeDeps();
    repo.maybePrune.mockRejectedValue(new Error('prune boom'));
    const runner = new JobRunnerService(lease as never, repo as never);
    const boom = new Error('boom');
    await expect(
      runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('passes the caller-chosen failure mode straight through to the lease', async () => {
    const { lease, repo } = makeDeps();
    const runner = new JobRunnerService(lease as never, repo as never);
    await runner.run('refresh', { ttlMs: 30_000, onRedisError: 'run-anyway' }, async () => 1);
    expect(lease.runExclusive).toHaveBeenCalledWith(
      'refresh',
      30_000,
      expect.any(Function),
      'run-anyway',
    );
  });
});
