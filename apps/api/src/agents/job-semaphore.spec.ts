import { JobSemaphore, SemaphoreRejected } from './job-semaphore';

const far = () => Date.now() + 60_000;

describe('JobSemaphore', () => {
  it('runs up to limit at once and queues the rest FIFO', async () => {
    const s = new JobSemaphore(2);
    const r1 = await s.acquire({ deadlineAt: far() });
    const r2 = await s.acquire({ deadlineAt: far() });
    expect(s.inFlight).toBe(2);
    const order: number[] = [];
    const p3 = s.acquire({ deadlineAt: far() }).then((r) => (order.push(3), r));
    const p4 = s.acquire({ deadlineAt: far() }).then((r) => (order.push(4), r));
    expect(s.queued).toBe(2);
    r1();
    const r3 = await p3;
    expect(s.inFlight).toBe(2);
    expect(s.queued).toBe(1);
    r2();
    const r4 = await p4;
    expect(order).toEqual([3, 4]);
    r3();
    r4();
    expect(s.inFlight).toBe(0);
  });

  it('release is idempotent', async () => {
    const s = new JobSemaphore(1);
    const r = await s.acquire({ deadlineAt: far() });
    r();
    r();
    expect(s.inFlight).toBe(0);
  });

  it('bounds the queue at 2x limit by default and rejects beyond it', async () => {
    const s = new JobSemaphore(1);
    expect(s.maxQueue).toBe(2);
    const r = await s.acquire({ deadlineAt: far() });
    const q1 = s.acquire({ deadlineAt: far() });
    const q2 = s.acquire({ deadlineAt: far() });
    await expect(s.acquire({ deadlineAt: far() })).rejects.toMatchObject({ reason: 'queue-full' });
    expect(s.queued).toBe(2);
    r();
    (await q1)();
    (await q2)();
    expect(s.inFlight).toBe(0);
  });

  it('rejects a queued request that cannot start before its deadline', async () => {
    const s = new JobSemaphore(1);
    const r = await s.acquire({ deadlineAt: far() });
    const t0 = Date.now();
    const err = await s.acquire({ deadlineAt: Date.now() + 40 }).catch((e) => e);
    expect(err).toBeInstanceOf(SemaphoreRejected);
    expect(err.reason).toBe('deadline');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    expect(s.queued).toBe(0);
    r();
    expect(s.inFlight).toBe(0);
  });

  it('rejects immediately when the deadline is already past', async () => {
    const s = new JobSemaphore(1);
    await expect(s.acquire({ deadlineAt: Date.now() - 1 })).rejects.toMatchObject({ reason: 'deadline' });
    expect(s.inFlight).toBe(0);
  });

  it('removes a queued waiter when its signal aborts, without taking a slot', async () => {
    const s = new JobSemaphore(1);
    const r = await s.acquire({ deadlineAt: far() });
    const ac = new AbortController();
    const p = s.acquire({ deadlineAt: far(), signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ reason: 'cancelled' });
    expect(s.queued).toBe(0);
    r();
    expect(s.inFlight).toBe(0);
  });

  it('a timed-out waiter does not consume a later freed slot', async () => {
    const s = new JobSemaphore(1);
    const r = await s.acquire({ deadlineAt: far() });
    await s.acquire({ deadlineAt: Date.now() + 10 }).catch(() => undefined);
    r();
    expect(s.inFlight).toBe(0);
    const r2 = await s.acquire({ deadlineAt: far() });
    expect(s.inFlight).toBe(1);
    r2();
  });
});
