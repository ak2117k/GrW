import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { CoreJournalPort } from './journal-ports';
import type { JournalEntry } from './journal.types';
import { CoreJournalRepository } from './repositories/core-journal.repository';

/** Load bounds (Global Constraints). */
export const JOURNAL_BUFFER_MAX = 1_000;
export const JOURNAL_RETRY_MS = 5_000;
export const JOURNAL_BATCH = 100;
/** A row that fails on its own this many times, while rows around it write, is dropped (review fix 4). */
export const JOURNAL_ROW_STRIKES = 2;
/** Consecutive single-row failures, with nothing written, after which a retry is settled by one probe. */
const OUTAGE_AFTER = 3;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Ruling J10. `record` never throws and never blocks its caller (lifecycle decisions, order
 * updates, the intake): rows wait in an ordered, bounded buffer and are written in batches; a
 * failed batch is retried row by row, so one bad row never blocks the rows behind it: a row that
 * fails twice while others write is dropped (counted, logged once); when nothing writes it is an
 * outage and everything stays queued for the 5 s retry. When the buffer is full further rows are
 * dropped and counted (the newest go). `recordNow` is for
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
  private readonly strikes = new Map<JournalEntry, number>();

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
        continue;
      } catch (err) {
        this.noteFailure(err);
      }
      // Re-read the head: rows recorded while the batch was in flight are tried too.
      if (!(await this.isolate(this.pending.slice(0, JOURNAL_BATCH)))) {
        this.logger.error(`journal write failed; ${this.pending.length} row(s) kept for the next try: ${this.lastError}`);
        return;
      }
    }
  }

  /**
   * Review fix 4: after a failed batch, write its rows one at a time. Returns false (an outage: keep
   * everything, no strikes) when nothing could be written; otherwise each row that failed on its own
   * takes a strike and is dropped at JOURNAL_ROW_STRIKES. Bounded: OUTAGE_AFTER failures in a row
   * with nothing written are settled by probing the batch's last row once.
   */
  private async isolate(batch: readonly JournalEntry[]): Promise<boolean> {
    const bad: JournalEntry[] = [];
    let wrote = false;
    for (const row of batch) {
      if (!this.pending.includes(row)) continue; // written by the probe below
      if (await this.writeOne(row)) {
        wrote = true;
        continue;
      }
      bad.push(row);
      if (!wrote && bad.length === OUTAGE_AFTER) {
        const last = batch[batch.length - 1];
        if (bad.includes(last) || !(await this.writeOne(last))) return false;
        wrote = true;
      }
    }
    if (!wrote) return false;
    for (const row of bad) {
      const n = (this.strikes.get(row) ?? 0) + 1;
      if (n < JOURNAL_ROW_STRIKES) {
        this.strikes.set(row, n);
        continue;
      }
      this.strikes.delete(row);
      this.pending.splice(this.pending.indexOf(row), 1);
      this.dropped += 1;
      this.logger.error(`journal row dropped after ${n} failed writes: ${row.type} for ${row.userId}${row.dedupeKey ? ` (${row.dedupeKey})` : ''}: ${this.lastError}`);
    }
    return true;
  }

  private async writeOne(row: JournalEntry): Promise<boolean> {
    try {
      this.written += await this.repo.append([row]);
      this.pending.splice(this.pending.indexOf(row), 1);
      this.strikes.delete(row);
      return true;
    } catch (err) {
      this.noteFailure(err);
      return false;
    }
  }

  private noteFailure(err: unknown): void {
    this.failures += 1;
    this.lastError = errorText(err);
  }
}
