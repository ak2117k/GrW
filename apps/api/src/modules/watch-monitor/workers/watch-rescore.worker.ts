import { Process, Processor, OnQueueActive, OnQueueFailed, InjectQueue } from '@nestjs/bull';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Queue, Job } from 'bull';
import { WatchMonitorService } from '../services/watch-monitor.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';

export const WATCH_RESCORE_QUEUE = 'watch-rescore';
const RESCORE_JOB_NAME = 'tick';
const RESCORE_EVERY_MS = 60_000;

@Processor(WATCH_RESCORE_QUEUE)
export class WatchRescoreWorker implements OnModuleInit {
  private readonly logger = new Logger(WatchRescoreWorker.name);

  constructor(
    @InjectQueue(WATCH_RESCORE_QUEUE) private readonly queue: Queue,
    private readonly monitor: WatchMonitorService,
  ) {}

  /**
   * DELIBERATELY NOT AWAITED — the port bind depends on it.
   *
   * The guard below handles Redis REJECTING. It does not help when Redis HANGS,
   * which is what an unreachable host usually produces: ioredis retries and the
   * promise never settles. Nest awaits every `onModuleInit` before
   * `app.listen()`, so an awaited hang here holds the port shut for good and
   * Render fails the deploy with "no open ports detected" — the same hazard
   * already fixed once in the market feed.
   *
   * Registering a repeatable job is background work by definition, so it runs
   * behind an already-listening server.
   */
  onModuleInit(): void {
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    void this.registerRepeatable();
  }

  private async registerRepeatable(): Promise<void> {
    // Redis may be briefly unreachable at boot (e.g. a cold DNS resolver on a
    // fresh container). These queue ops await Redis; if they reject and escape
    // this method, the rejection is unhandled and surfaces at the process
    // handler with no attribution. Guard them so a transient Redis hiccup only
    // skips repeatable-job registration (the app still starts and serves); the
    // job re-registers on the next boot.
    try {
      const repeatables = await this.queue.getRepeatableJobs();
      for (const r of repeatables) {
        if (r.name === RESCORE_JOB_NAME) {
          await this.queue.removeRepeatableByKey(r.key);
        }
      }
      await this.queue.add(
        RESCORE_JOB_NAME,
        {},
        { repeat: { every: RESCORE_EVERY_MS }, removeOnComplete: true, removeOnFail: true },
      );
      this.logger.log(`Registered watch-rescore repeating job (every ${RESCORE_EVERY_MS}ms)`);
    } catch (err) {
      this.logger.error(
        `Could not register watch-rescore repeating job (Redis unavailable at boot?): ` +
        `${err instanceof Error ? err.message : err}. App will start without it.`,
      );
    }
  }

  @OnQueueActive()
  onActive(job: Job) {
    this.logger.debug(`watch-rescore tick started (job ${job.id})`);
  }

  @OnQueueFailed()
  onFailed(job: Job, err: Error) {
    this.logger.warn(`watch-rescore tick failed (job ${job.id}): ${err.message}`);
  }

  @Process(RESCORE_JOB_NAME)
  async handle(): Promise<void> {
    await this.monitor.tickAll();
  }
}
