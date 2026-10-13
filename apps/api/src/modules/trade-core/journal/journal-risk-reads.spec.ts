import { JournalRiskReads } from './journal-risk-reads';
import { MemoryJournalStore } from './testing/memory-journal-store';

describe('JournalRiskReads.latched (J13)', () => {
  it('is true only for the user and IST day that has a DAILY_LOSS_LATCHED row', async () => {
    const s = new MemoryJournalStore();
    await s.repo.append([{ type: 'DAILY_LOSS_LATCHED', userId: 'user_A', at: new Date('2026-10-13T05:00:00.000Z'), payload: {}, dedupeKey: 'latch:user_A:2026-10-13' }]);
    const r = new JournalRiskReads(s.repo);
    expect(await r.latched('user_A', '2026-10-13')).toBe(true);
    expect(await r.latched('user_A', '2026-10-14')).toBe(false);
    expect(await r.latched('user_B', '2026-10-13')).toBe(false);
  });
});
