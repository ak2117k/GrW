import { dayPnlPath } from './pnl-path';
import type { ClosedTrade } from './desk.types';

const t = (min: number, pnl: number): ClosedTrade => ({
  trackerId: `t${min}`,
  symbol: 'X',
  underlying: 'X',
  exitAt: new Date(Date.UTC(2026, 10, 26, 4, min)),
  pnl,
  origin: 'manual',
});

describe('dayPnlPath', () => {
  it('peak and drawdown', () => {
    const p = dayPnlPath([t(3, -2500), t(1, -1000), t(2, 3000)], -500);
    expect(p).toEqual(expect.objectContaining({ realised: -500, open: -500, total: -1000, peak: 2000, drawdownFromPeak: 3000, lossStreak: 1 }));
    expect(p.closed.map((c) => c.pnl)).toEqual([-1000, 3000, -2500]);
  });

  it('trailing streak', () => {
    expect(dayPnlPath([t(1, 500), t(2, -100), t(3, -200), t(4, -300)], 0).lossStreak).toBe(3);
  });

  it('zero ends streak', () => {
    expect(dayPnlPath([t(1, -100), t(2, 0)], 0).lossStreak).toBe(0);
  });

  it('empty day', () => {
    expect(dayPnlPath([], -700)).toEqual(expect.objectContaining({ peak: 0, total: -700, drawdownFromPeak: 700, lossStreak: 0 }));
  });

  it('open profit sets the peak', () => {
    expect(dayPnlPath([t(1, 1000)], 2500)).toEqual(expect.objectContaining({ peak: 3500, drawdownFromPeak: 0 }));
  });
});
