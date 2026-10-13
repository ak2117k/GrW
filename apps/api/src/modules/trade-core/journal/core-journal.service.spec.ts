import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { CoreJournalService, JOURNAL_BUFFER_MAX } from './core-journal.service';
import type { JournalEntry } from './journal.types';
import { CoreJournalRepository } from './repositories/core-journal.repository';
import { MemoryJournalStore } from './testing/memory-journal-store';
import { tenantStampingPrisma } from './testing/tenant-prisma';

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
    expect(journal.status()).toMatchObject({ pending: 2, failures: 3, lastError: 'journal down' }); // the batch, then each row alone
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

describe('CoreJournalService under a request tenant scope (review fix 1: cross-tenant journal writes)', () => {
  function realStack() {
    const cls = new ClsService(new AsyncLocalStorage());
    const tenant = new TenantContextService(cls);
    const db = tenantStampingPrisma(tenant, ['coreJournal']);
    const repo = new CoreJournalRepository(db.prisma as unknown as PrismaService, tenant, cls);
    return { cls, tenant, db, journal: new CoreJournalService(repo) };
  }
  const row = (userId: string, type: JournalEntry['type']): JournalEntry => ({ userId, type, at: AT, payload: {} });

  it("a USER's request that drains the buffer writes the owner's pending rows under the OWNER's userId", async () => {
    const { cls, tenant, db, journal } = realStack();
    db.failOnce();
    db.failOnce();
    journal.record(row('owner', 'FILL')); // background row; its writes fail (batch, then alone) so it stays pending
    await journal.flush();
    expect(journal.status().pending).toBe(1);
    await cls.run(async () => {
      tenant.set({ userId: 'user_B', role: 'USER' });
      journal.record(row('user_B', 'KILL_SWITCH'));
      await journal.flush();
      expect(tenant.get()).toEqual({ userId: 'user_B', role: 'USER' }); // the request keeps its scope
    });
    expect(db.rows.coreJournal.map((r) => [r.userId, r.type])).toEqual([['owner', 'FILL'], ['user_B', 'KILL_SWITCH']]);
  });

  it("recordNow inside a USER's request keeps the entry's own userId", async () => {
    const { cls, tenant, db, journal } = realStack();
    await cls.run(async () => {
      tenant.set({ userId: 'user_B', role: 'USER' });
      await journal.recordNow(row('owner', 'RECON_MISMATCH'));
    });
    expect(db.rows.coreJournal.map((r) => r.userId)).toEqual(['owner']);
  });
});

describe('CoreJournalService — a permanently failing row (review fix 4)', () => {
  it('never blocks the rows behind it, and is dropped (counted, logged) once it has failed twice', async () => {
    const { store, journal } = setup();
    store.rejectRow = (x) => x.type === 'BLIND';
    journal.record(e('BLIND'));
    journal.record(e('FILL'));
    journal.record(e('ORDER_STATE'));
    await journal.flush();
    expect(store.rows.map((r) => r.type)).toEqual(['FILL', 'ORDER_STATE']);
    expect(journal.status()).toMatchObject({ pending: 1, dropped: 0 });
    journal.record(e('STOP_MOVED'));
    await journal.flush();
    expect(store.rows.map((r) => r.type)).toEqual(['FILL', 'ORDER_STATE', 'STOP_MOVED']);
    expect(journal.status()).toMatchObject({ pending: 0, dropped: 1 });
  });

  it('an outage is not a bad row: nothing is dropped however often it is retried, and each retry is bounded', async () => {
    const { store, journal } = setup();
    store.failWrites = true;
    for (let i = 0; i < 10; i += 1) journal.record(e('FILL'));
    await journal.flush();
    store.appendCalls = 0;
    for (let i = 0; i < 5; i += 1) await journal.flush();
    expect(journal.status()).toMatchObject({ pending: 10, dropped: 0 });
    expect(store.appendCalls).toBeLessThanOrEqual(5 * 5);
    store.failWrites = false;
    await journal.flush();
    expect(store.rows).toHaveLength(10);
  });
});
