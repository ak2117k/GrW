import type { CoreJournalPort } from '../journal-ports';
import type { JournalEntry, JournalType } from '../journal.types';

/** CoreJournalPort for unit specs: records what writers hand it; `failNow` makes recordNow reject. */
export class FakeJournal implements CoreJournalPort {
  readonly entries: JournalEntry[] = [];
  failNow = false;

  record(e: JournalEntry): void {
    this.entries.push(e);
  }

  async recordNow(e: JournalEntry): Promise<void> {
    if (this.failNow) throw new Error('journal down');
    this.entries.push(e);
  }

  types(): JournalType[] {
    return this.entries.map((e) => e.type);
  }

  ofType(type: JournalType): JournalEntry[] {
    return this.entries.filter((e) => e.type === type);
  }
}
