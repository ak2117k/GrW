import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { FANOUT_JOB, FANOUT_JOB_OPTS, SIGNAL_FANOUT_QUEUE } from '../constants';
import type { FanoutJob, PublicSignal } from '../dto/public-signal.dto';

/**
 * The producer helper injected into `AnandDualTrackService` (TDA-010 §7). Emits
 * ONE `signal-fanout` job per successful per-segment entry insert.
 *
 * Best-effort BY CONTRACT: a failure to enqueue is swallowed (logged, never
 * thrown) so a fan-out hiccup can never block or fail the entry insert that
 * triggered it. A dropped enqueue means a missed auto-trade for one signal,
 * never a corrupted product feed.
 */
@Injectable()
export class SignalFanoutService {
  private readonly logger = new Logger(SignalFanoutService.name);

  constructor(
    @InjectQueue(SIGNAL_FANOUT_QUEUE) private readonly fanoutQueue: Queue<FanoutJob>,
  ) {}

  async enqueueFanout(signal: PublicSignal): Promise<void> {
    try {
      await this.fanoutQueue.add(FANOUT_JOB, { signal }, FANOUT_JOB_OPTS);
    } catch (err) {
      this.logger.warn(
        `[signal-fanout] enqueue failed for entry ${signal.entryId} (${signal.segment}): ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
