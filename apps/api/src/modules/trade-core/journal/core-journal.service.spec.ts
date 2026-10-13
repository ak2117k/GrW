import { CoreJournalService, JOURNAL_BUFFER_MAX } from './core-journal.service';
import type { JournalEntry } from './journal.types';
import { MemoryJournalStore } from './testing/memory-journal-store';

const AT = new Date('2026-10-13T05:00:00.000Z');
const e = (type: JournalEntry['type'], dedupeKey: string | null = null): JournalEntry => ({ userId: 'user_A', type, at: AT, payload: {}, dedupeKey });

function setup() {
  const store = new MemoryJournalStore();
  return { store, journal: new CoreJournalService(store.repo) };
}

describe('CoreJournalService (ruling J10, Review Focus 3)', () => {
  it('record writes in the order given, batched, never throwing', async () => {
    const { store, journal } = setup();
    journal.record(e('ORDER_PLACED'));
    journal.record(e('ORDER_STATE'));
    journal.record(e('FILL'));
    await journal.flush();
    expect(store.rows.map((r) => r.type)).toEqual(['ORDER_PLACED', 'ORDER_STATE', 'FILL']);
    expect(journal.status()).toMatchObject({ pending: 0, written: 3, dropped: 0, failures: 0 });
  });

  it('a failed batch stays queued and is retried in order once the store is back', async () => {
    const { store, journal } = setup();
    store.failWrites = true;
    journal.record(e('BLIND'));
    journal.record(e('POSITION_STATE'));
    await journal.flush();
    expect(store.rows).toEqual([]);
    expect(journal.status()).toMatchObject({ pending: 2, failures: 1, lastError: 'journal down' });
    store.failWrites = false;
    await journal.flush();
    expect(store.rows.map((r) => r.type)).toEqual(['BLIND', 'POSITION_STATE']);
    expect(journal.status().pending).toBe(0);
  });

  it(`a full buffer (${JOURNAL_BUFFER_MAX}) drops further rows and counts them; it never throws`, async () => {
    const { store, journal } = setup();
    store.failWrites = true;
    for (let i = 0; i < JOURNAL_BUFFER_MAX + 3; i += 1) expect(() => journal.record(e('STOP_MOVED'))).not.toThrow();
    await journal.flush();
    expect(journal.status()).toMatchObject({ pending: JOURNAL_BUFFER_MAX, dropped: 3 });
  });

  it('recordNow resolves once written (a duplicate key is fine) and rejects when the store is down', async () => {
    const { store, journal } = setup();
    await journal.recordNow(e('DAILY_LOSS_LATCHED', 'latch:user_A:2026-10-13'));
    await expect(journal.recordNow(e('DAILY_LOSS_LATCHED', 'latch:user_A:2026-10-13'))).resolves.toBeUndefined();
    expect(store.rows).toHaveLength(1);
    store.failWrites = true;
    await expect(journal.recordNow(e('RISK_VERDICT'))).rejects.toThrow('journal down');
  });

  it('shutdown flushes what is queued', async () => {
    const { store, journal } = setup();
    journal.record(e('EXIT_DECIDED'));
    await journal.onModuleDestroy();
    expect(store.rows.map((r) => r.type)).toEqual(['EXIT_DECIDED']);
  });
});
