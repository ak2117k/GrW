/**
 * TDA-010 Task 5 — end-to-end retry → DLQ proof against REAL Bull + Redis.
 *
 * Boots a focused Nest module wiring the execute-user + execute-user-dead queues
 * on the live Redis (td-redis) under an ISOLATED prefix so it can never touch
 * dev/prod queues. A throwing AUTO_EXECUTION_PORT drives a job to exhaust its
 * attempts; the @OnQueueFailed handler must move the payload into the DLQ. A
 * sibling job with a passing port completes and never lands in the DLQ (§7).
 *
 * Run from apps/api (Redis on 127.0.0.1:6379):
 *   npx jest --config test/tda010/jest.config.js dlq-integration --runInBand
 */
import { BullModule, getQueueToken } from '@nestjs/bull';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bull';
import { EXECUTE_USER_DEAD_QUEUE, EXECUTE_USER_JOB, EXECUTE_USER_QUEUE } from '../../src/modules/signal-fanout/constants';
import { PerUserRateLimiter } from '../../src/modules/signal-fanout/services/per-user-rate-limiter';
import { AUTO_EXECUTION_PORT, ExecuteUserWorker } from '../../src/modules/signal-fanout/workers/execute-user.worker';
import { ExecuteUserJob, idempotencyKeyFor } from '../../src/modules/signal-fanout/dto/public-signal.dto';

const TEST_PREFIX = `tda010test:${process.pid}`;
const signal = {
  entryId: 'e1', symbol: 'TCS', segment: 'INTRADAY' as const, side: 'BUY' as const,
  entryPrice: 100, targetPct: 5, stopPct: 5, token: '11536',
};
const jobFor = (userId: string): ExecuteUserJob => ({
  userId, signal, idempotencyKey: idempotencyKeyFor(signal.entryId, userId),
});

// Port that rejects for user 'A' (drives it to the DLQ) and resolves for others.
const port = { execute: jest.fn((j: ExecuteUserJob) =>
  j.userId === 'A' ? Promise.reject(new Error('A broker hard-reject')) : Promise.resolve()) };

let moduleRef: TestingModule;
let execQueue: Queue<ExecuteUserJob>;
let deadQueue: Queue;

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 9000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for condition');
}

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [
      BullModule.forRoot({
        redis: { host: '127.0.0.1', port: 6379 },
        prefix: TEST_PREFIX,
      }),
      BullModule.registerQueue({ name: EXECUTE_USER_QUEUE }, { name: EXECUTE_USER_DEAD_QUEUE }),
    ],
    providers: [
      ExecuteUserWorker,
      PerUserRateLimiter,
      { provide: AUTO_EXECUTION_PORT, useValue: port },
    ],
  }).compile();
  await moduleRef.init();

  execQueue = moduleRef.get(getQueueToken(EXECUTE_USER_QUEUE));
  deadQueue = moduleRef.get(getQueueToken(EXECUTE_USER_DEAD_QUEUE));
  await execQueue.obliterate({ force: true });
  await deadQueue.obliterate({ force: true });
}, 30000);

afterAll(async () => {
  await execQueue?.obliterate({ force: true }).catch(() => undefined);
  await deadQueue?.obliterate({ force: true }).catch(() => undefined);
  await moduleRef?.close();
});

describe('execute-user retry → DLQ (real Bull)', () => {
  it('exhausts attempts on a failing job and dead-letters its payload; a sibling completes', async () => {
    await execQueue.add(EXECUTE_USER_JOB, jobFor('A'), {
      attempts: 2, backoff: { type: 'fixed', delay: 100 }, removeOnComplete: true, removeOnFail: false,
    });
    await execQueue.add(EXECUTE_USER_JOB, jobFor('B'), {
      attempts: 2, backoff: { type: 'fixed', delay: 100 }, removeOnComplete: true, removeOnFail: false,
    });

    // A must land in the DLQ after exhausting its 2 attempts.
    await waitFor(async () => (await deadQueue.getJobCounts()).waiting >= 1);

    const dead = await deadQueue.getJobs(['waiting', 'active', 'completed', 'delayed']);
    expect(dead).toHaveLength(1);
    expect(dead[0].data).toMatchObject({
      userId: 'A',
      idempotencyKey: jobFor('A').idempotencyKey,
      error: 'A broker hard-reject',
    });

    // B completed via the passing port and never entered the DLQ.
    await waitFor(async () => port.execute.mock.calls.some((c) => c[0].userId === 'B'));
    expect(dead.every((j) => j.data.userId !== 'B')).toBe(true);
  }, 20000);
});
