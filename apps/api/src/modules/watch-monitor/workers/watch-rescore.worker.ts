import { Process, Processor, OnQueueActive, OnQueueFailed, InjectQueue } from '@nestjs/bull';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Queue, Job } from 'bull';
import { WatchMonitorService } from '../services/watch-monitor.service';

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

  async onModuleInit() {
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
