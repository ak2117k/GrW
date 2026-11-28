import { dayPnlPath, guardDayPath, positionOpenPnl, type GuardOpenTrade } from './pnl-path';
import type { ClosedTrade, TradeOrigin } from './desk.types';

const t = (min: number, pnl: number, origin: TradeOrigin = 'manual', symbol = 'X'): ClosedTrade => ({
  trackerId: `t${min}`,
  symbol,
  underlying: 'X',
  exitAt: new Date(Date.UTC(2026, 10, 26, 4, min)),
  pnl,
  origin,
});
const o = (id: string, pnl: number | null, origin: TradeOrigin = 'manager', symbol = 'NIFTY02DEC2625000CE'): GuardOpenTrade => ({ trackerId: id, symbol, pnl, origin });

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

describe('positionOpenPnl (the one open-P&L reading: the positions block value)', () => {
  it('is the tracker pnl; a missing or non-finite pnl reads 0', () => {
    expect(positionOpenPnl(-4399)).toBe(-4399);
    expect(positionOpenPnl(null)).toBe(0);
    expect(positionOpenPnl(undefined)).toBe(0);
    expect(positionOpenPnl(Number.NaN)).toBe(0);
  });
});

describe('guardDayPath: only the desk manager\'s own trades', () => {
  it('owner manual losers and a held owner position never reach the path; they are reported as ownerPnl', () => {
    const p = guardDayPath(
      [t(1, 2409, 'manager'), t(2, -900), t(3, -1100), t(4, -800)],
      [o('maz', -4399, 'manual', 'MAZDOCK29DEC261760PE')],
      ['MAZDOCK29DEC261760PE'],
    );
    expect(p).toEqual(expect.objectContaining({ realised: 2409, open: 0, total: 2409, peak: 2409, drawdownFromPeak: 0, lossStreak: 0 }));
    expect(p.closed.map((c) => c.trackerId)).toEqual(['t1']);
    expect(p.ownerPnl).toEqual({ realised: -2800, open: -4399 });
  });

  it('a held MANAGER position is excluded too (open and closed), and never in the streak', () => {
    const p = guardDayPath(
      [t(1, -500, 'manager', 'HELDX'), t(2, -500, 'manager', 'HELDX'), t(3, -500, 'manager', 'HELDX')],
      [o('h', -4000, 'manager', 'HELDX')],
      ['HELDX'],
    );
    expect(p).toEqual(expect.objectContaining({ realised: 0, open: 0, lossStreak: 0 }));
    expect(p.ownerPnl).toEqual({ realised: -1500, open: -4000 });
  });

  it('hold by tracker id matches as well as by symbol', () => {
    const p = guardDayPath([], [o('trk-1', -700)], ['TRK-1']);
    expect(p.open).toBe(0);
    expect(p.ownerPnl.open).toBe(-700);
  });

  it('manager trades build the drawdown and the streak', () => {
    const p = guardDayPath([t(1, 1000, 'manager'), t(2, -2600, 'manager'), t(3, -1500, 'manager')], [o('m', -2000)], []);
    expect(p).toEqual(expect.objectContaining({ realised: -3100, open: -2000, total: -5100, peak: 1000, drawdownFromPeak: 6100, lossStreak: 2 }));
    expect(p.ownerPnl).toEqual({ realised: 0, open: 0 });
  });

  it('signal / reentry / unknown origins are not desk trades (reported in ownerPnl)', () => {
    const p = guardDayPath([t(1, -100, 'signal'), t(2, -200, 'reentry'), t(3, -300, 'unknown')], [o('s', -50, 'signal')], []);
    expect(p).toEqual(expect.objectContaining({ realised: 0, open: 0, lossStreak: 0 }));
    expect(p.ownerPnl).toEqual({ realised: -600, open: -50 });
  });

  it('open P&L is the positions-block value (whole tracker pnl), a null pnl counts 0', () => {
    const p = guardDayPath([], [o('a', -1200.5), o('b', null), o('c', 200)], []);
    expect(p.open).toBe(-1000.5);
  });
});
