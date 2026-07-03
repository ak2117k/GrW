import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { AuditService } from '../../../common/audit/audit.service';
import {
  EXECUTE_USER_CONCURRENCY,
  EXECUTE_USER_DEAD_QUEUE,
  EXECUTE_USER_JOB,
  EXECUTE_USER_QUEUE,
} from '../constants';
import { PerUserRateLimiter } from '../services/per-user-rate-limiter';
import type { ExecuteUserJob } from '../dto/public-signal.dto';

/**
 * DI token for the TDA-011 per-user execution pipeline. TDA-010 binds it
 * `@Optional()` so this fan-out lane can land + be tested standalone BEFORE
 * TDA-011 provides the implementation.
 */
export const AUTO_EXECUTION_PORT = Symbol('AUTO_EXECUTION_PORT');

/**
 * The seam TDA-011 implements: given one `execute-user` job (a sanitized signal
 * for one eligible user + a stable idempotency key), run the authoritative
 * gate → consent → size → decrypt → place → audit pipeline. TDA-010 only calls
 * it behind the per-user rate gate; it owns none of that pipeline.
 */
export interface AutoExecutionPort {
  execute(job: ExecuteUserJob): Promise<void>;
}

/**
 * The per-user execution worker SHELL (TDA-010 §3, §6). Provides:
 *  - the per-user rate gate (acquire a token before any broker call),
 *  - delegation to the TDA-011 `AutoExecutionPort` (no-op + warn when unbound),
 *  - retry/backoff (via the job options set at enqueue) + a dead-letter move
 *    when a job exhausts its attempts.
 *
 * Isolation: every user is a separate job, so a throw here fails ONLY this job;
 * Bull retries/backoff and the DLQ move are per-job and never touch siblings.
 */
@Injectable()
@Processor(EXECUTE_USER_QUEUE)
export class ExecuteUserWorker {
  private readonly logger = new Logger(ExecuteUserWorker.name);

  constructor(
    private readonly rateLimiter: PerUserRateLimiter,
    @InjectQueue(EXECUTE_USER_DEAD_QUEUE) private readonly deadQueue: Queue,
    @Optional() @Inject(AUTO_EXECUTION_PORT) private readonly autoExec?: AutoExecutionPort,
    @Optional() private readonly audit?: AuditService,
  ) {}

  // Concurrency is load-bearing for failure isolation: at Bull's default of 1,
  // a single user's slow/hung/rate-limited job would block the whole fleet's
  // execution. EXECUTE_USER_CONCURRENCY lets N users progress in parallel.
  @Process({ name: EXECUTE_USER_JOB, concurrency: EXECUTE_USER_CONCURRENCY })
  async handle(job: Job<ExecuteUserJob>): Promise<void> {
    const { userId } = job.data;

    // Per-user rate gate — self-paces this user without touching another's bucket.
    await this.rateLimiter.acquire(userId);

    if (!this.autoExec) {
      // This lane merges before TDA-011: the topology is live, the pipeline is not.
      this.logger.warn(
        `[execute-user] no AUTO_EXECUTION_PORT bound (TDA-011 pending) — no-op for user ${userId}`,
      );
      return;
    }

    await this.autoExec.execute(job.data);
  }

  /**
   * Dead-letter handler. Bull emits `failed` after EVERY failed attempt; we move
   * the payload to `execute-user-dead` only once the job has EXHAUSTED its
   * attempts (so a mid-retry failure is not prematurely dead-lettered). The DLQ
   * is never auto-replayed — a replayed order is a real-money duplicate.
   */
  @OnQueueFailed()
  async onFailed(job: Job<ExecuteUserJob>, err: Error): Promise<void> {
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return; // retries remain

    const reason = err?.message ?? String(err);
    try {
      await this.deadQueue.add(EXECUTE_USER_JOB, { ...job.data, error: reason });
    } catch (e) {
      this.logger.error(
        `[execute-user] failed to dead-letter job for user ${job.data?.userId}: ` +
          `${e instanceof Error ? e.message : e}`,
      );
    }

    await this.audit
      ?.append({
        action: 'ORDER_REJECTED',
        userId: job.data.userId,
        target: job.data.signal?.entryId,
        meta: { reason: 'DLQ_EXHAUSTED', idempotencyKey: job.data.idempotencyKey, error: reason },
      })
      .catch((e) =>
        this.logger.warn(`[execute-user] DLQ audit append failed: ${e instanceof Error ? e.message : e}`),
      );
  }
}
