import { signalPaperDigest, signalTradeStats } from './signal-trades';

describe('signalTradeStats', () => {
  it('splits the paper trades by the OI check at entry, GROSS from entry / exit / qty (never the booked pnl); no verdict = NO_DATA', () => {
    const at = new Date('2026-10-29T08:41:00Z');
    // The booked pnl is double-counted on purpose (the 28–29 Oct closeTrade bug); the split must ignore it.
    const tr = (entry: number, exit: number | null, qty: number, pnl: number) => ({ createdAt: at, status: exit === null ? 'OPEN' : 'CLOSED', side: 'BUY', quantity: qty, entryPrice: entry, exitPrice: exit, pnl });
    const s = signalTradeStats(
      {
        paper: [
          { ...tr(100, 88, 100, -2400), oiVerdict: 'AGAINST' as const },
          { ...tr(50, 42, 100, -1600), oiVerdict: 'AGAINST' as const },
          { ...tr(100, 105, 100, 1000), oiVerdict: 'AGREES' as const, aiDecision: 'TAKE' as const },
          { ...tr(100, null, 10, 50) },
        ],
        live: [],
      },
      ['2026-10-29'],
    );
    expect(s.session.paperByOi.AGAINST).toMatchObject({ n: 2, losses: 2, gross: -2000, winRate: 0 });
    expect(s.session.paperByOi.AGREES).toMatchObject({ n: 1, wins: 1, gross: 500 });
    expect(s.rolling20.paperByOi.NO_DATA).toMatchObject({ n: 1, open: 1, openMark: 50 });
    expect(s.session.paperByJudge.TAKE).toMatchObject({ n: 1, gross: 500 });
    expect(s.session.paperByJudge.NONE.n).toBe(3);
    expect(s.session.paperNoFunds.n).toBe(4);
    expect(s.session.paperTrades[0]).toMatchObject({ status: 'CLOSED', gross: -1200, oiVerdict: 'AGAINST', aiDecision: 'NONE', oiSummary: null });
    expect(s.session.paperTrades[3].gross).toBeNull();
    const d = signalPaperDigest(s)!;
    expect(d.basis).toMatch(/^gross/);
    expect(d.rolling20.byOi.AGAINST).toEqual({ n: 2, closed: 2, wins: 0, losses: 2, winRate: 0, gross: -2000, openMark: 0 });
    expect(d.session.byOi.NO_DATA).toMatchObject({ n: 1, closed: 0, openMark: 50 });
    expect(d.sessionTrades).toHaveLength(4);
    expect(signalPaperDigest(signalTradeStats({ paper: [], live: [] }, ['2026-10-29']))).toBeNull();
    expect(signalPaperDigest(undefined)).toBeNull();
  });
});
