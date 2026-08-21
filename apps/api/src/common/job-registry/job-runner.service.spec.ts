import { JobRunnerService } from './job-runner.service';

function makeDeps(leaseAcquired = true) {
  const lease = {
    runExclusive: jest.fn(async (_name: string, _ttl: number, fn: () => Promise<unknown>) =>
      leaseAcquired ? await fn() : null,
    ),
  };
  const repo = {
    recordStart: jest.fn().mockResolvedValue('row-1'),
    recordEnd: jest.fn().mockResolvedValue(undefined),
    recordSkipped: jest.fn().mockResolvedValue(undefined),
  };
  return { lease, repo };
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
