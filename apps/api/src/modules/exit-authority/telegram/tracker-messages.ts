import { Injectable } from '@nestjs/common';

/**
 * One live owner message per TRADE (design §4.5 B: "one message per trade, edited, not spammed").
 * In-process map trackerId → Telegram message_id, shared by the escalation runner and the owner buttons.
 * Restart-safe through trade_alarms.telegramMessageId: the runner re-seeds it from the open alarms each pass,
 * and blockedExit falls back to the newest alarm's message id.
 */
@Injectable()
export class TrackerMessages {
  private readonly byTracker = new Map<string, number>();

  get(trackerId: string): number | null {
    return this.byTracker.get(trackerId) ?? null;
  }

  set(trackerId: string, messageId: number | null): void {
    if (messageId == null) this.byTracker.delete(trackerId);
    else this.byTracker.set(trackerId, messageId);
  }

  /** Seed only when nothing is known in-process (after a restart). */
  seed(trackerId: string, messageId: number): void {
    if (!this.byTracker.has(trackerId)) this.byTracker.set(trackerId, messageId);
  }

  clear(trackerId: string): void {
    this.byTracker.delete(trackerId);
  }
}
