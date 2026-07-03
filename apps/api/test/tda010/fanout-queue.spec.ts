import { SignalFanoutWorker } from '../../src/modules/signal-fanout/workers/signal-fanout.worker';
import { ExecuteUserWorker } from '../../src/modules/signal-fanout/workers/execute-user.worker';
import { SignalFanoutService } from '../../src/modules/signal-fanout/services/signal-fanout.service';
import { idempotencyKeyFor, ExecuteUserJob, PublicSignal } from '../../src/modules/signal-fanout/dto/public-signal.dto';
import { ANAND_PROVENANCE_KEYS } from '../../src/modules/anand-dual-track/dto/public-entry.dto';
import { EXECUTE_USER_JOB, FANOUT_JOB } from '../../src/modules/signal-fanout/constants';

const signal: PublicSignal = {
  entryId: 'e1', symbol: 'TCS', segment: 'INTRADAY', side: 'BUY',
  entryPrice: 100, targetPct: 5, stopPct: 5, token: '11536',
};

describe('SignalFanoutService.enqueueFanout', () => {
  it('adds exactly one signal-fanout job carrying the PublicSignal', async () => {
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const svc = new SignalFanoutService(queue as any);
    await svc.enqueueFanout(signal);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(FANOUT_JOB, { signal }, expect.any(Object));
  });

  it('is best-effort: a queue.add rejection never throws or propagates', async () => {
    const queue = { add: jest.fn().mockRejectedValue(new Error('redis down')) };
    const svc = new SignalFanoutService(queue as any);
    await expect(svc.enqueueFanout(signal)).resolves.toBeUndefined();
  });
});

describe('SignalFanoutWorker', () => {
  const eligibility = { eligibleUserIds: jest.fn() };
  const worker = (add: jest.Mock) =>
    new SignalFanoutWorker({ add } as any, eligibility as any);

  beforeEach(() => jest.clearAllMocks());

  it('enqueues one provenance-safe execute-user job per eligible user with distinct idempotency keys', async () => {
    eligibility.eligibleUserIds.mockResolvedValue([
      { userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' },
    ]);
    const add = jest.fn().mockResolvedValue({});
    await worker(add).handle({ data: { signal } } as any);

    expect(add).toHaveBeenCalledTimes(3);
    const keys = add.mock.calls.map((c) => c[1].idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toContain(idempotencyKeyFor('e1', 'u1'));

    // Each job = { userId, signal, idempotencyKey } and nothing else.
    expect(add.mock.calls[0][0]).toBe(EXECUTE_USER_JOB);
    expect(add.mock.calls[0][1]).toEqual({
      userId: 'u1', signal, idempotencyKey: idempotencyKeyFor('e1', 'u1'),
    });

    // Provenance-safety of the queued payload.
    const json = JSON.stringify(add.mock.calls.map((c) => c[1]));
    for (const k of [...ANAND_PROVENANCE_KEYS, 'alertId']) expect(json).not.toContain(k);
  });

  it('isolates a per-user enqueue failure: u1 and u3 still enqueue when u2 rejects', async () => {
    eligibility.eligibleUserIds.mockResolvedValue([
      { userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' },
    ]);
    const add = jest.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({});
    await expect(worker(add).handle({ data: { signal } } as any)).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledTimes(3);
    expect(add.mock.calls.map((c) => c[1].userId)).toEqual(['u1', 'u2', 'u3']);
  });
});

const job = (userId: string): ExecuteUserJob => ({
  userId,
  signal,
  idempotencyKey: idempotencyKeyFor(signal.entryId, userId),
});

describe('ExecuteUserWorker.handle — rate gate then delegate', () => {
  it('acquires a per-user rate token BEFORE delegating to the execution port', async () => {
    const acquire = jest.fn().mockResolvedValue(undefined);
    const execute = jest.fn().mockResolvedValue(undefined);
    const w = new ExecuteUserWorker({ acquire } as any, { add: jest.fn() } as any, { execute });

    await w.handle({ data: job('u1') } as any);

    expect(acquire).toHaveBeenCalledWith('u1');
    expect(execute).toHaveBeenCalledWith(job('u1'));
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
  });

  it('no-ops (no throw) when the AUTO_EXECUTION_PORT is unbound (TDA-011 not merged)', async () => {
    const acquire = jest.fn().mockResolvedValue(undefined);
    const w = new ExecuteUserWorker({ acquire } as any, { add: jest.fn() } as any, undefined);
    await expect(w.handle({ data: job('u1') } as any)).resolves.toBeUndefined();
    expect(acquire).toHaveBeenCalledWith('u1');
  });
});

describe('ExecuteUserWorker.onFailed — retry exhaustion → DLQ', () => {
  const acquire = jest.fn().mockResolvedValue(undefined);

  it('does NOT dead-letter while retries remain', async () => {
    const add = jest.fn().mockResolvedValue({});
    const w = new ExecuteUserWorker({ acquire } as any, { add } as any, { execute: jest.fn() });
    await w.onFailed({ data: job('u1'), attemptsMade: 1, opts: { attempts: 3 } } as any, new Error('broker 500'));
    expect(add).not.toHaveBeenCalled();
  });

  it('dead-letters the payload + error + idempotencyKey once attempts are exhausted', async () => {
    const add = jest.fn().mockResolvedValue({});
    const audit = { append: jest.fn().mockResolvedValue({}) };
    const w = new ExecuteUserWorker({ acquire } as any, { add } as any, { execute: jest.fn() }, audit as any);

    await w.onFailed({ data: job('u1'), attemptsMade: 3, opts: { attempts: 3 } } as any, new Error('broker hard-reject'));

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][1]).toMatchObject({
      userId: 'u1', idempotencyKey: job('u1').idempotencyKey, error: 'broker hard-reject',
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORDER_REJECTED',
        userId: 'u1',
        meta: expect.objectContaining({ reason: 'DLQ_EXHAUSTED' }),
      }),
    );
  });
});

describe('ExecuteUserWorker — per-job isolation', () => {
  it('user A throwing + dead-lettered does not affect user B completing', async () => {
    const acquire = jest.fn().mockResolvedValue(undefined);
    const add = jest.fn().mockResolvedValue({});
    // Port rejects for A, resolves for B.
    const execute = jest.fn((j: ExecuteUserJob) =>
      j.userId === 'A' ? Promise.reject(new Error('A broker down')) : Promise.resolve(),
    );
    const w = new ExecuteUserWorker({ acquire } as any, { add } as any, { execute });

    await expect(w.handle({ data: job('A') } as any)).rejects.toThrow('A broker down');
    await expect(w.handle({ data: job('B') } as any)).resolves.toBeUndefined();

    // A exhausts and dead-letters; B never touches the DLQ.
    await w.onFailed({ data: job('A'), attemptsMade: 3, opts: { attempts: 3 } } as any, new Error('A broker down'));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][1].userId).toBe('A');
    expect(execute).toHaveBeenCalledWith(job('B'));
  });
});
