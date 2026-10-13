import { dailySummary } from './daily-summary';
import { MemoryJournalStore } from './testing/memory-journal-store';

describe('dailySummary (spec §8.4: net P&L, trades, win rate, charges as % of gross)', () => {
  const s = new MemoryJournalStore();
  const t = (over: Parameters<MemoryJournalStore['sampleSummary']>[0]) => ({ ...s.sampleSummary(over), id: 'x', createdAt: new Date() });

  it('adds the day up; costs = charges + MTF interest; % of |gross|', () => {
    const win = t({ grossPnl: '1250.00', charges: '43.00', mtfInterest: '0.00', netPnl: '1207.00' });
    const loss = t({ positionId: 'p2', grossPnl: '-200.00', charges: '40.00', mtfInterest: '10.00', netPnl: '-250.00' });
    expect(dailySummary([win, loss])).toEqual({
      trades: 2, wins: 1, losses: 1, winRatePct: '50.0', grossPnl: '1050.00', costs: '93.00', netPnl: '957.00', costsPctOfGross: '8.9',
    });
  });

  it('an empty day has no rates', () => {
    expect(dailySummary([])).toEqual({ trades: 0, wins: 0, losses: 0, winRatePct: null, grossPnl: '0.00', costs: '0.00', netPnl: '0.00', costsPctOfGross: null });
  });
});
