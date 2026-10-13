import { MemoryJournalStore } from './memory-journal-store';

const AT = new Date('2026-10-13T04:00:00.000Z');

describe('MemoryJournalStore (the repositories twin)', () => {
  it('dedupes by key, keeps order, and fails every write while failWrites is on', async () => {
    const s = new MemoryJournalStore();
    expect(await s.repo.append([{ userId: 'u', type: 'FILL', at: AT, payload: {}, dedupeKey: 'k' }, { userId: 'u', type: 'FILL', at: AT, payload: {}, dedupeKey: 'k' }])).toBe(1);
    s.failWrites = true;
    await expect(s.repo.append([{ userId: 'u', type: 'BLIND', at: AT, payload: {} }])).rejects.toThrow(/journal down/);
    expect(s.rows.map((r) => r.type)).toEqual(['FILL']);
  });

  it('summaries: one per position (first write wins), read back by user only', async () => {
    const s = new MemoryJournalStore();
    const base = s.sampleSummary({ userId: 'u', positionId: 'p1' });
    await s.summaryRepo.createIfAbsent(base);
    expect((await s.summaryRepo.createIfAbsent({ ...base, netPnl: '9.99' })).netPnl).toBe(base.netPnl);
    expect(s.summaries).toHaveLength(1);
    expect(await s.summaryRepo.findByPosition('other', 'p1')).toBeNull();
    expect((await s.summaryRepo.positionIdsWithSummary('u', ['p1', 'p2'])).has('p1')).toBe(true);
  });
});
