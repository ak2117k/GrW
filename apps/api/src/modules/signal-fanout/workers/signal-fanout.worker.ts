import { Process, Processor, InjectQueue } from '@nestjs/bull';
import { Logger, Optional } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { AuditService } from '../../../common/audit/audit.service';
import {
  EXECUTE_USER_JOB,
  EXECUTE_USER_QUEUE,
  FANOUT_JOB,
  FANOUT_JOB_OPTS,
  SIGNAL_FANOUT_QUEUE,
} from '../constants';
import { FanoutEligibilityService } from '../services/fanout-eligibility.service';
import {
  ExecuteUserJob,
  FanoutJob,
  idempotencyKeyFor,
} from '../dto/public-signal.dto';

/**
 * Consumes one `signal-fanout` job and fans it out to one INDEPENDENT
 * `execute-user` job per eligible user (TDA-010 §3, §6).
 *
 * Isolation: every user is a separate job, and each `queue.add` is INDIVIDUALLY
 * try/caught — a failure to enqueue user K's job is logged but the loop
 * continues for users K+1…N. The fan-out job itself only fails (and retries) if
 * the eligibility enumeration throws.
 */
@Processor(SIGNAL_FANOUT_QUEUE)
export class SignalFanoutWorker {
  private readonly logger = new Logger(SignalFanoutWorker.name);

  constructor(
    @InjectQueue(EXECUTE_USER_QUEUE) private readonly executeUserQueue: Queue<ExecuteUserJob>,
    private readonly eligibility: FanoutEligibilityService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  @Process(FANOUT_JOB)
  async handle(job: Job<FanoutJob>): Promise<void> {
    const { signal } = job.data;
    const users = await this.eligibility.eligibleUserIds(signal.segment);

    for (const user of users) {
      const payload: ExecuteUserJob = {
        userId: user.userId,
        signal,
        idempotencyKey: idempotencyKeyFor(signal.entryId, user.userId),
      };
      try {
        await this.executeUserQueue.add(EXECUTE_USER_JOB, payload, FANOUT_JOB_OPTS);
      } catch (err) {
        // Per-user isolation: one enqueue failure never blocks siblings.
        this.logger.warn(
          `[signal-fanout] FANOUT_ENQUEUE_FAILED entry=${signal.entryId} user=${user.userId}: ` +
            `${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
