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

describe('JournalRiskReads.reconBlock (O10)', () => {
  it('unacked findings block their strategies; a null-strategy finding blocks all; an ack lifts it', async () => {
    const s = new MemoryJournalStore();
    const at = new Date('2026-10-13T05:00:00.000Z');
    await s.repo.append([
      { type: 'RECON_MISMATCH', userId: 'user_A', at, strategyId: 'cs_a', payload: {} },
      { type: 'RECON_MISMATCH', userId: 'user_A', at, strategyId: null, payload: {} },
    ]);
    const r = new JournalRiskReads(s.repo);
    expect(await r.reconBlock('user_A')).toEqual({ all: true, strategyIds: ['cs_a'] });
    await s.repo.append([{ type: 'RECON_ACK', userId: 'user_A', at, payload: {}, dedupeKey: `ack:${s.rows[1].id}` }]);
    expect(await r.reconBlock('user_A')).toEqual({ all: false, strategyIds: ['cs_a'] });
    expect(await r.reconBlock('user_B')).toEqual({ all: false, strategyIds: [] });
  });
});
