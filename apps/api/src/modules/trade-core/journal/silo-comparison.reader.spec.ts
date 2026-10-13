import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { CorePositionRepository } from '../lifecycle/repositories/core-position.repository';
import { SiloComparisonReader } from './silo-comparison.reader';
import { MemoryJournalStore } from './testing/memory-journal-store';

const AT = new Date('2026-10-13T05:00:00.000Z');

describe('SiloComparisonReader (spec §8.4, J21)', () => {
  it("pairs each core setup with the silo's entry for the same alert and token", async () => {
    const store = new MemoryJournalStore();
    const alert = (intentId: string, token: string, strategyKey: string) => ({
      type: 'ALERT_RECEIVED' as const, userId: 'user_A', at: AT, intentId, symbol: 'X-EQ', strategyId: `cs_${strategyKey}`, payload: { alertId: 'alert_1', token, strategyKey },
    });
    await store.repo.append([
      alert('ci_traded', '2885', 'adaptive-stop'),
      alert('ci_skipped', '1594', 'ungated'),
      { type: 'INTENT_SKIPPED', userId: 'user_A', at: AT, intentId: 'ci_skipped', payload: { reason: 'STALE_ENTRY' } },
      alert('ci_open', '3045', 'adaptive-stop'),
    ]);
    await store.summaryRepo.createIfAbsent(store.sampleSummary({ intentId: 'ci_traded', positionId: 'pos_t', netPnl: '1207.00', exitReason: 'TARGET', qty: 200, istDay: '2026-10-13' }));
    const prisma = {
      adaptiveStopWatchEntry: { findMany: jest.fn().mockResolvedValue([{ alertId: 'alert_1', token: '2885', status: 'EXECUTED', paperTradeId: 'ast_1' }]) },
      adaptiveStopTrade: { findMany: jest.fn().mockResolvedValue([{ id: 'ast_1', pnl: 900, fees: 40, exitReasonTag: 'TRAIL', status: 'CLOSED' }]) },
      ungatedWatchEntry: { findMany: jest.fn().mockResolvedValue([{ alertId: 'alert_1', token: '1594', status: 'EXECUTED', paperTradeId: 'ugt_1' }]) },
      ungatedTrade: { findMany: jest.fn().mockResolvedValue([{ id: 'ugt_1', pnl: -300, fees: 35, exitReasonTag: 'STOP', status: 'CLOSED' }]) },
    };
    const positions = { findByIntent: jest.fn(async (id: string) => (id === 'ci_open' ? { id: 'pos_o', userId: 'user_A', status: 'OPEN', entryFilledQty: 100 } : null)) };
    const rows = await new SiloComparisonReader(prisma as unknown as PrismaService, store.repo, store.summaryRepo, positions as unknown as CorePositionRepository).forDay('user_A', '2026-10-13');
    expect(rows).toEqual([
      expect.objectContaining({ intentId: 'ci_traded', strategyKey: 'adaptive-stop', core: { outcome: 'TRADED', reason: 'TARGET', netPnl: '1207.00', qty: 200 }, silo: { track: 'adaptive-stop', status: 'EXECUTED', pnl: 900, fees: 40, exitReason: 'TRAIL' } }),
      expect.objectContaining({ intentId: 'ci_skipped', core: { outcome: 'SKIPPED', reason: 'STALE_ENTRY', netPnl: null, qty: null }, silo: expect.objectContaining({ track: 'ungated', pnl: -300 }) }),
      expect.objectContaining({ intentId: 'ci_open', core: { outcome: 'OPEN', reason: 'OPEN', netPnl: null, qty: 100 }, silo: null }),
    ]);
    expect(prisma.adaptiveStopWatchEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { alertId: { in: ['alert_1'] } } }));
  });

  it("never shows another user's position (findByIntent is global) and reads nothing for a day without setups", async () => {
    const store = new MemoryJournalStore();
    const empty = { findMany: jest.fn().mockResolvedValue([]) };
    const prisma = { adaptiveStopWatchEntry: empty, adaptiveStopTrade: empty, ungatedWatchEntry: empty, ungatedTrade: empty };
    const positions = { findByIntent: jest.fn().mockResolvedValue({ id: 'pos_b', userId: 'user_B', status: 'OPEN', entryFilledQty: 5 }) };
    const reader = new SiloComparisonReader(prisma as unknown as PrismaService, store.repo, store.summaryRepo, positions as unknown as CorePositionRepository);
    expect(await reader.forDay('user_A', '2026-10-13')).toEqual([]);
    expect(empty.findMany).not.toHaveBeenCalled();
    await store.repo.append([{ type: 'ALERT_RECEIVED', userId: 'user_A', at: AT, intentId: 'ci_x', payload: { alertId: 'alert_2', token: '1', strategyKey: 'adaptive-stop' } }]);
    const [row] = await reader.forDay('user_A', '2026-10-13');
    expect(row.core).toEqual({ outcome: 'PENDING', reason: null, netPnl: null, qty: null });
  });
});
