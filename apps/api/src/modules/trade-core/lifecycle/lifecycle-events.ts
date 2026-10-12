import { Injectable, Logger } from '@nestjs/common';
import type { LifecycleEvent } from './lifecycle.types';

/** Ruling L12 / O6: where lifecycle events go. M4 logs them; M5 rebinds this to core_journal. */
export const LIFECYCLE_EVENT_SINK = Symbol('LIFECYCLE_EVENT_SINK');

export interface LifecycleEventSink {
  record(e: LifecycleEvent): Promise<void>;
}

@Injectable()
export class LoggingLifecycleEventSink implements LifecycleEventSink {
  private readonly logger = new Logger('CoreLifecycle');

  async record(e: LifecycleEvent): Promise<void> {
    this.logger.log(
      JSON.stringify({ type: e.type, userId: e.userId, positionId: e.positionId, payload: e.payload, priceUsed: e.priceUsed, priceAgeMs: e.priceAgeMs, at: e.at.toISOString() }),
    );
  }
}
