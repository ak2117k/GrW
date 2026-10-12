import { AiQueueTimeout, PriorityScheduler } from './priority-scheduler';

/** A function the test resolves by hand. */
function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('PriorityScheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('with a free slot, starts fn synchronously and reports queuedMs 0', async () => {
    const s = new PriorityScheduler({ 'claude-cli': 1 });
    const fn = jest.fn().mockResolvedValue('ok');
    const p = s.run('claude-cli', 0, 1000, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toEqual({ result: 'ok', queuedMs: 0 });
  });

  it('a running call blocks the next one when the limit is reached', async () => {
    const s = new PriorityScheduler({ 'claude-cli': 1 });
    const first = deferred();
    s.run('claude-cli', 0, 10_000, () => first.promise);
    const second = jest.fn().mockResolvedValue('b');
    const p2 = s.run('claude-cli', 0, 10_000, second);
    expect(second).not.toHaveBeenCalled();
    jest.advanceTimersByTime(250);
    first.resolve('a');
    await flush();
    expect(second).toHaveBeenCalledTimes(1);
    const r = await p2;
    expect(r.result).toBe('b');
    expect(r.queuedMs).toBeGreaterThanOrEqual(250);
  });

  it('starts a higher-priority (lower number) call before an earlier lower-priority one', async () => {
    const s = new PriorityScheduler({ 'claude-cli': 1 });
    const blocker = deferred();
    s.run('claude-cli', 0, 10_000, () => blocker.promise);
    const order: string[] = [];
    const p4 = s.run('claude-cli', 4, 10_000, async () => order.push('p4'));
    const p0 = s.run('claude-cli', 0, 10_000, async () => order.push('p0'));
    blocker.resolve('x');
    await Promise.all([p4, p0]);
    expect(order).toEqual(['p0', 'p4']);
  });

  it('is FIFO within one priority', async () => {
    const s = new PriorityScheduler({ 'claude-cli': 1 });
    const blocker = deferred();
    s.run('claude-cli', 0, 10_000, () => blocker.promise);
    const order: number[] = [];
    const ps = [1, 2, 3].map((n) => s.run('claude-cli', 2, 10_000, async () => order.push(n)));
    blocker.resolve('x');
    await Promise.all(ps);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects with AiQueueTimeout when not started within maxWaitMs, and never runs fn', async () => {
    const s = new PriorityScheduler({ 'claude-cli': 1 });
    const blocker = deferred();
    s.run('claude-cli', 0, 10_000, () => blocker.promise);
    const fn = jest.fn();
    const p = s.run('claude-cli', 3, 500, fn);
    jest.advanceTimersByTime(500);
    await expect(p).rejects.toBeInstanceOf(AiQueueTimeout);
    blocker.resolve('x');
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('frees the slot when fn rejects, and propagates the same error', async () => {
    const s = new PriorityScheduler({ 'claude-cli': 1 });
    const err = new Error('boom');
    const p1 = s.run('claude-cli', 0, 1000, () => Promise.reject(err));
    const next = jest.fn().mockResolvedValue('n');
    const p2 = s.run('claude-cli', 0, 1000, next);
    await expect(p1).rejects.toBe(err);
    await expect(p2).resolves.toEqual(expect.objectContaining({ result: 'n' }));
  });

  it('frees the slot when fn throws synchronously', async () => {
    const s = new PriorityScheduler({ 'claude-cli': 1 });
    const p1 = s.run('claude-cli', 0, 1000, () => {
      throw new Error('sync');
    });
    await expect(p1).rejects.toThrow('sync');
    await expect(s.run('claude-cli', 0, 1000, async () => 'ok')).resolves.toEqual({ result: 'ok', queuedMs: 0 });
  });

  it('limits are per provider', async () => {
    const s = new PriorityScheduler({ 'claude-cli': 1, 'anthropic-api': 1 });
    s.run('claude-cli', 0, 1000, () => deferred().promise);
    const api = jest.fn().mockResolvedValue('api');
    s.run('anthropic-api', 0, 1000, api);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('defaults: claude-cli 2, anthropic-api 8', () => {
    const s = new PriorityScheduler({});
    const cli = Array.from({ length: 3 }, () => jest.fn(() => deferred().promise));
    cli.forEach((fn) => s.run('claude-cli', 0, 1000, fn));
    expect(cli.filter((f) => f.mock.calls.length > 0)).toHaveLength(2);
    const api = Array.from({ length: 9 }, () => jest.fn(() => deferred().promise));
    api.forEach((fn) => s.run('anthropic-api', 0, 1000, fn));
    expect(api.filter((f) => f.mock.calls.length > 0)).toHaveLength(8);
  });

  it('a timed-out waiter does not consume a slot later', async () => {
    const s = new PriorityScheduler({ 'claude-cli': 1 });
    const blocker = deferred();
    s.run('claude-cli', 0, 10_000, () => blocker.promise);
    const timedOut = s.run('claude-cli', 0, 100, jest.fn());
    jest.advanceTimersByTime(100);
    await expect(timedOut).rejects.toBeInstanceOf(AiQueueTimeout);
    const later = jest.fn().mockResolvedValue('later');
    const p = s.run('claude-cli', 0, 10_000, later);
    blocker.resolve('x');
    await expect(p).resolves.toEqual(expect.objectContaining({ result: 'later' }));
  });
});
