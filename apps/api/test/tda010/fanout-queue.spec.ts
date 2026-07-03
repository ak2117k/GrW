import { SignalFanoutWorker } from '../../src/modules/signal-fanout/workers/signal-fanout.worker';
import { SignalFanoutService } from '../../src/modules/signal-fanout/services/signal-fanout.service';
import { idempotencyKeyFor, PublicSignal } from '../../src/modules/signal-fanout/dto/public-signal.dto';
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
