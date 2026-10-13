import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { CoreJournalPort } from './journal-ports';
import type { JournalEntry } from './journal.types';
import { CoreJournalRepository } from './repositories/core-journal.repository';

/** Load bounds (Global Constraints). */
export const JOURNAL_BUFFER_MAX = 1_000;
export const JOURNAL_RETRY_MS = 5_000;
export const JOURNAL_BATCH = 100;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Ruling J10. `record` never throws and never blocks its caller (lifecycle decisions, order
 * updates, the intake): rows wait in an ordered, bounded buffer and are written in batches; a
 * failed batch stays at the head and is retried every 5 s; when the buffer is full further rows
 * are dropped and counted (the newest go, so a batch in flight stays aligned). `recordNow` is for
 * callers that must know the row exists (the Risk Wall verdict, the latch, recon, follow-ups).
 */
@Injectable()
export class CoreJournalService implements CoreJournalPort, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CoreJournal');
  private readonly pending: JournalEntry[] = [];
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private written = 0;
  private dropped = 0;
  private failures = 0;
  private lastError: string | null = null;

  constructor(private readonly repo: CoreJournalRepository) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), JOURNAL_RETRY_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  record(e: JournalEntry): void {
    if (this.pending.length >= JOURNAL_BUFFER_MAX) {
      this.dropped += 1;
      this.logger.error(`journal buffer full (${JOURNAL_BUFFER_MAX}): ${e.type} for ${e.userId} dropped (${this.dropped} so far)`);
      return;
    }
    this.pending.push(e);
    void this.flush();
  }

  async recordNow(e: JournalEntry): Promise<void> {
    try {
      this.written += await this.repo.append([e]);
    } catch (err) {
      this.failures += 1;
      this.lastError = errorText(err);
      throw err;
    }
  }

  flush(): Promise<void> {
    if (!this.flushing) this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  status(): { pending: number; written: number; dropped: number; failures: number; lastError: string | null } {
    return { pending: this.pending.length, written: this.written, dropped: this.dropped, failures: this.failures, lastError: this.lastError };
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, JOURNAL_BATCH);
      try {
        this.written += await this.repo.append(batch);
        this.pending.splice(0, batch.length);
      } catch (err) {
        this.failures += 1;
        this.lastError = errorText(err);
        this.logger.error(`journal write failed; ${this.pending.length} row(s) kept for the next try: ${this.lastError}`);
        return;
      }
    }
  }
}
