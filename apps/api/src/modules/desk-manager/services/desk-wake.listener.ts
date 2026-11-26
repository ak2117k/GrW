import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { READER_READING_STORED_EVENT, type ReadingStoredEvent } from '../../message-reader/services/message-reader.service';
import type { WakeReason } from '../domain/desk.types';
import { ManagerRunnerService } from './manager-runner.service';

/** The app-wide event other modules emit to wake the manager early (no module imports the manager). */
export const DESK_WAKE_EVENT = 'desk.wake';
export interface DeskWakeEvent {
  reason: WakeReason;
}

const REASONS: ReadonlySet<string> = new Set<WakeReason>([
  'cadence', 'reading_call', 'claim_on_open', 'tracker_opened', 'tracker_closed', 'sentinel_exit', 'sentinel_hold_loss',
  'judge_take_skipped', 'guard_change', 'target_crossed', 'watch_recheck', 'manual',
]);

@Injectable()
export class DeskWakeListener {
  private readonly logger = new Logger(DeskWakeListener.name);

  constructor(private readonly runner: ManagerRunnerService) {}

  /**
   * A fresh channel CALL / UPDATE reading wakes the manager at once (the 2026-11-26 BSE post was a CALL the
   * rules missed). Other readings wait for the cadence.
   */
  @OnEvent(READER_READING_STORED_EVENT)
  onReading(e: ReadingStoredEvent): void {
    if (e && (e.kind === 'CALL' || e.kind === 'UPDATE')) this.runner.wake('reading_call');
  }

  @OnEvent(DESK_WAKE_EVENT)
  onWake(e: DeskWakeEvent): void {
    const reason = e && typeof e.reason === 'string' && REASONS.has(e.reason) ? e.reason : null;
    if (!reason) return void this.logger.warn(`[desk-manager] ignored wake event ${JSON.stringify(e)}`);
    this.runner.wake(reason);
  }
}
