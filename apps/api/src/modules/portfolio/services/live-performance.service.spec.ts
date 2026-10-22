import {
  LivePerformanceService,
  buildLiveDashboard,
  buildLiveTrades,
  classifySegment,
  istDay,
} from './live-performance.service';
import type {
  LiveExitRow,
  LiveOrderRow,
  LiveTrackerRow,
} from '../repositories/live-trades.repository';

const utc = (s: string) => new Date(`${s}Z`);

const tracker = (over: Partial<LiveTrackerRow> = {}): LiveTrackerRow => ({
  id: 't1',
  symbol: 'RELIANCE-EQ',
  exchange: 'NSE',
  token: '2885',
  kind: 'POSITION',
  entryPrice: 100,
  qty: 10,
  entryTime: utc('2026-10-20T04:00:00'),
  exitPrice: null,
  exitTime: null,
  status: 'OPEN',
  lastLtp: 105,
  pnl: 50,
  pnlPercent: 5,
  ...over,
});

const exit = (over: Partial<LiveExitRow> = {}): LiveExitRow => ({
  trackerId: 't1',
  verdictId: 'cv_123',
  mode: 'live',
  status: 'FILLED',
  verdictReason: 'thesis broken',
  fillPrice: 98,
  createdAt: utc('2026-10-20T08:00:00'),
  ...over,
});

const order = (over: Partial<LiveOrderRow> = {}): LiveOrderRow => ({
  id: 'o1',
  side: 'BUY',
  quantity: 10,
  entryPrice: 100,
  exitPrice: null,
  pnl: null,
  pnlPercent: null,
  status: 'OPEN',
  strategy: 'rsi-reversal',
  source: 'AUTO',
  entryTime: utc('2026-10-20T03:59:00'),
  exitTime: null,
  createdAt: utc('2026-10-20T03:59:00'),
  instrument: { symbol: 'RELIANCE-EQ', exchange: 'NSE', segment: 'EQUITY', token: '2885' },
  ...over,
});

describe('live-performance helpers', () => {
  it('istDay groups by the IST calendar day, not UTC', () => {
    // 20:00 UTC on the 20th is 01:30 IST on the 21st.
    expect(istDay(utc('2026-10-20T20:00:00'))).toBe('2026-10-21');
    expect(istDay(utc('2026-10-20T18:29:00'))).toBe('2026-10-20');
  });

  it('classifySegment maps exchanges and F&O symbols', () => {
    expect(classifySegment('NFO', 'NIFTY28OCT2625000CE')).toBe('OPTIONS');
    expect(classifySegment('NFO', 'BANKNIFTY28OCT26FUT')).toBe('FUTURES');
    expect(classifySegment('MCX', 'CRUDEOIL19NOV26FUT')).toBe('COMMODITY');
    expect(classifySegment('NSE', 'TCS-EQ')).toBe('EQUITY');
    expect(classifySegment('BSE', 'TCS')).toBe('EQUITY');
  });
});

describe('buildLiveTrades — attribution', () => {
  it('a broker position with no app rows is opened and closed MANUAL', () => {
    const [row] = buildLiveTrades(
      [tracker({ status: 'CLOSED', exitPrice: 110, exitTime: utc('2026-10-21T09:00:00'), pnl: 100 })],
      [],
      [],
    );
    expect(row).toMatchObject({ openedBy: 'MANUAL', closedBy: 'MANUAL', status: 'CLOSED', pnl: 100, exitPrice: 110 });
  });

  it('a live AI exit row marks the tracker closed by the AGENT, with the verdict reason', () => {
    const [row] = buildLiveTrades(
      [tracker({ status: 'CLOSED', exitPrice: 98, exitTime: utc('2026-10-20T08:01:00'), pnl: -20 })],
      [exit()],
      [],
    );
    expect(row.closedBy).toBe('AGENT');
    expect(row.closeNote).toBe('thesis broken');
  });

  it("the owner's in-app Exit now is MANUAL and a price trigger is TRIGGER", () => {
    const closed = { status: 'CLOSED', exitTime: utc('2026-10-20T08:01:00'), exitPrice: 99 };
    const rows = buildLiveTrades(
      [tracker({ ...closed, id: 'a' }), tracker({ ...closed, id: 'b', token: '1' })],
      [exit({ trackerId: 'a', verdictId: 'man_a_1' }), exit({ trackerId: 'b', verdictId: 'trg_xyz' })],
      [],
    );
    expect(rows.find((r) => r.id === 'a')?.closedBy).toBe('MANUAL');
    expect(rows.find((r) => r.id === 'b')?.closedBy).toBe('TRIGGER');
  });

  it('an exit row on a still-OPEN tracker does not mark it closed', () => {
    const [row] = buildLiveTrades([tracker()], [exit()], []);
    expect(row.status).toBe('OPEN');
    expect(row.closedBy).toBeNull();
  });

  it('a live model order on the same token is attributed and NOT double-counted', () => {
    const rows = buildLiveTrades(
      [tracker({ status: 'CLOSED', exitPrice: 110, exitTime: utc('2026-10-21T09:00:00'), pnl: 100 })],
      [],
      [order({ status: 'CLOSED', exitTime: utc('2026-10-21T09:00:00'), pnl: 100 })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ openedBy: 'MODEL', closedBy: 'MODEL', strategy: 'rsi-reversal' });
  });

  it('a live order with no tracker is still listed', () => {
    const rows = buildLiveTrades(
      [],
      [],
      [order({ side: 'SELL', status: 'CLOSED', exitPrice: 90, exitTime: utc('2026-10-20T06:00:00'), pnl: 100 })],
    );
    expect(rows[0]).toMatchObject({ origin: 'ORDER', side: 'SHORT', closedBy: 'MODEL', pnl: 100 });
  });

  it('a short tracker (negative qty) is SHORT with absolute qty', () => {
    const [row] = buildLiveTrades([tracker({ qty: -75, exchange: 'NFO', symbol: 'NIFTY28OCT2625000PE' })], [], []);
    expect(row).toMatchObject({ side: 'SHORT', qty: 75, segment: 'OPTIONS' });
  });
});

describe('buildLiveDashboard', () => {
  const now = utc('2026-10-22T06:00:00'); // 11:30 IST on the 22nd

  it('builds daily P&L by IST exit day, cumulative equity, drawdown and today', () => {
    const rows = buildLiveTrades(
      [
        tracker({ id: 'a', status: 'CLOSED', exitTime: utc('2026-10-20T09:00:00'), exitPrice: 110, pnl: 100 }),
        // 19:00 UTC on the 20th = 00:30 IST on the 21st.
        tracker({ id: 'b', token: '2', status: 'CLOSED', exitTime: utc('2026-10-20T19:00:00'), exitPrice: 85, pnl: -150 }),
        tracker({ id: 'c', token: '3', status: 'CLOSED', exitTime: utc('2026-10-22T05:00:00'), exitPrice: 104, pnl: 40 }),
        tracker({ id: 'd', token: '4', pnl: 25 }), // open
      ],
      [exit({ trackerId: 'b' })],
      [],
    );
    const d = buildLiveDashboard(rows, now);
    expect(d.dailyPnl).toEqual([
      { date: '2026-10-20', pnl: 100 },
      { date: '2026-10-21', pnl: -150 },
      { date: '2026-10-22', pnl: 40 },
    ]);
    expect(d.equityCurve.map((p) => p.equity)).toEqual([100, -50, -10]);
    expect(d.summary).toMatchObject({
      realisedPnl: -10,
      todayRealisedPnl: 40,
      unrealisedPnl: 25,
      openPositions: 1,
      closedTrades: 3,
      wins: 2,
      losses: 1,
      maxDrawdown: 150,
    });
    expect(d.summary.winRate).toBeCloseTo(66.67, 1);
    expect(d.segments).toEqual([{ segment: 'EQUITY', pnl: -10, trades: 3, wins: 2, losses: 1 }]);
    expect(d.closedBy).toEqual(
      expect.arrayContaining([
        { closedBy: 'MANUAL', trades: 2, pnl: 140 },
        { closedBy: 'AGENT', trades: 1, pnl: -150 },
      ]),
    );
    // Newest activity first: today's close leads.
    expect(d.recent[0].id).toBe('c');
  });

  it('is all zeros with empty series when there are no live trades', () => {
    const d = buildLiveDashboard([], now);
    expect(d.summary.closedTrades).toBe(0);
    expect(d.summary.winRate).toBe(0);
    expect(d.equityCurve).toEqual([]);
    expect(d.dailyPnl).toEqual([]);
  });
});

describe('LivePerformanceService', () => {
  it('reads every source for the given userId only', async () => {
    const repo = {
      listTrackers: jest.fn().mockResolvedValue([tracker()]),
      listLiveExits: jest.fn().mockResolvedValue([]),
      listLiveOrders: jest.fn().mockResolvedValue([]),
    };
    const svc = new LivePerformanceService(repo as any);
    const d = await svc.getDashboard('usr_1', utc('2026-10-22T06:00:00'));
    expect(repo.listTrackers).toHaveBeenCalledWith('usr_1');
    expect(repo.listLiveExits).toHaveBeenCalledWith('usr_1');
    expect(repo.listLiveOrders).toHaveBeenCalledWith('usr_1');
    expect(d.summary.openPositions).toBe(1);
  });
});
