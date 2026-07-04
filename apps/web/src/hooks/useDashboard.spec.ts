import { describe, it, expect } from 'vitest';
import { pickHeroStats } from './useDashboard';

describe('pickHeroStats', () => {
  it('reads totals from a populated summary', () => {
    expect(pickHeroStats({ totalPnl: 12345, winRate: 0.6, totalTrades: 20 } as never)).toEqual({ totalPnl: 12345, winRate: 0.6, trades: 20 });
  });
  it('is null-safe for an empty/paper account', () => {
    expect(pickHeroStats(null)).toEqual({ totalPnl: 0, winRate: 0, trades: 0 });
  });
});
