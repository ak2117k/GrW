import { Logger } from '@nestjs/common';
import { CronLeaseService } from './cron-lease.service';
import type { LeaseRedis } from './cron-lease.redis';

/**
 * A tiny in-memory stand-in for Redis with real `SET NX PX` and real
 * compare-and-delete semantics, so the tests exercise the ACTUAL contract the
 * lease depends on (NX rejects while held, DEL only when the token matches)
 * rather than a mock that simply returns whatever the test wanted. No live
 * server is involved.
 */
class FakeRedis implements LeaseRedis {
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  now = 1_000_000;
  failWith: Error | null = null;
  evalCalls: Array<{ key: string; token: string }> = [];

  async set(key: string, value: string, _px: 'PX', ttlMs: number, _nx: 'NX') {
    if (this.failWith) throw this.failWith;
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > this.now) return null;
    this.store.set(key, { value, expiresAt: this.now + ttlMs });
    return 'OK' as const;
  }

  async eval(_script: string, _numKeys: number, key: string, token: string) {
    if (this.failWith) throw this.failWith;
    this.evalCalls.push({ key, token });
    const existing = this.store.get(key);
    if (existing && existing.value === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
}

const KEY = 'cron-lease:reconcile';

describe('CronLeaseService', () => {
  let redis: FakeRedis;
  let service: CronLeaseService;

  beforeEach(() => {
    redis = new FakeRedis();
    service = new CronLeaseService(redis);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('acquires the lease, runs the job, and returns its value', async () => {
    const job = jest.fn().mockResolvedValue('done');

    const result = await service.runExclusive('reconcile', 60_000, job, 'skip');

    expect(result).toBe('done');
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('does NOT run the job when another instance already holds the lease', async () => {
    redis.store.set(KEY, { value: 'other-instance:1', expiresAt: redis.now + 60_000 });
    const job = jest.fn().mockResolvedValue('done');

    const result = await service.runExclusive('reconcile', 60_000, job, 'skip');

    expect(result).toBeNull();
    expect(job).not.toHaveBeenCalled();
    // The other instance's lease is untouched — we neither ran nor stole it.
    expect(redis.store.get(KEY)?.value).toBe('other-instance:1');
  });

  it('releases the lease on success, so the next tick can acquire it', async () => {
    await service.runExclusive('reconcile', 60_000, async () => 'first', 'skip');
    expect(redis.store.has(KEY)).toBe(false);

    const second = jest.fn().mockResolvedValue('second');
    await expect(service.runExclusive('reconcile', 60_000, second, 'skip')).resolves.toBe(
      'second',
    );
  });

  it('releases the lease when the job THROWS, and rethrows the job error', async () => {
    const boom = new Error('job blew up');

    await expect(
      service.runExclusive('reconcile', 60_000, async () => {
        throw boom;
      }, 'skip'),
    ).rejects.toBe(boom);

    // A held-to-TTL lease would mute this job for the whole TTL after a single
    // exception — the very failure the finally-release exists to prevent.
    expect(redis.store.has(KEY)).toBe(false);
  });

  it('does not delete a lease it no longer owns (token mismatch after expiry)', async () => {
    const job = jest.fn().mockImplementation(async () => {
      // The lease expires mid-run and a different instance legitimately takes it.
      redis.now += 61_000;
      redis.store.set(KEY, { value: 'other-instance:1', expiresAt: redis.now + 60_000 });
      return 'slow';
    });

    await service.runExclusive('reconcile', 60_000, job, 'skip');

    expect(redis.evalCalls).toHaveLength(1);
    expect(redis.store.get(KEY)?.value).toBe('other-instance:1');
  });

  it('gives each acquisition a distinct token, so a stale run cannot free a newer lease', async () => {
    await service.runExclusive('reconcile', 60_000, async () => 1, 'skip');
    await service.runExclusive('reconcile', 60_000, async () => 2, 'skip');

    expect(redis.evalCalls[0].token).not.toBe(redis.evalCalls[1].token);
  });

  it('fail-OPEN: runs the job anyway when Redis errors', async () => {
    redis.failWith = new Error('ECONNREFUSED');
    const job = jest.fn().mockResolvedValue('ran');

    const result = await service.runExclusive('refresh', 60_000, job, 'run-anyway');

    expect(result).toBe('ran');
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('fail-CLOSED: skips the job when Redis errors', async () => {
    redis.failWith = new Error('ECONNREFUSED');
    const job = jest.fn().mockResolvedValue('ran');

    const result = await service.runExclusive('sentinel-cycle', 60_000, job, 'skip');

    expect(result).toBeNull();
    expect(job).not.toHaveBeenCalled();
  });

  it('wrappers select the failure mode explicitly', async () => {
    redis.failWith = new Error('ECONNREFUSED');
    const open = jest.fn().mockResolvedValue('ran');
    const closed = jest.fn().mockResolvedValue('ran');

    await expect(service.runExclusiveFailOpen('refresh', 60_000, open)).resolves.toBe('ran');
    await expect(service.runExclusiveFailClosed('spend', 60_000, closed)).resolves.toBeNull();
    expect(closed).not.toHaveBeenCalled();
  });

  it('does not let a failed release mask the job result', async () => {
    const job = jest.fn().mockImplementation(async () => {
      redis.failWith = new Error('connection lost');
      return 'value';
    });

    await expect(service.runExclusive('reconcile', 60_000, job, 'skip')).resolves.toBe('value');
  });

  it('runs the job unleased when leasing is switched off (no Redis client)', async () => {
    const unleased = new CronLeaseService(null);
    const job = jest.fn().mockResolvedValue('ran');

    await expect(unleased.runExclusive('refresh', 60_000, job, 'skip')).resolves.toBe('ran');
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-positive TTL rather than routing a coding bug through onRedisError', async () => {
    const job = jest.fn();

    await expect(service.runExclusive('reconcile', 0, job, 'skip')).rejects.toThrow(/ttlMs/);
    expect(job).not.toHaveBeenCalled();
  });
});
