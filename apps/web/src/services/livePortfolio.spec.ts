import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./api', () => ({ default: { get: vi.fn() } }));

import api from './api';
import {
  closedByLabel,
  filterLiveTrades,
  getLiveDashboard,
  getLiveJournal,
  lastN,
  liveTotals,
  type LiveTradeRow,
} from './livePortfolio';

const row = (over: Partial<LiveTradeRow> = {}): LiveTradeRow => ({
  id: 'r1',
  origin: 'TRACKER',
  symbol: 'TCS-EQ',
  exchange: 'NSE',
  segment: 'EQUITY',
  kind: 'POSITION',
  side: 'LONG',
  qty: 1,
  entryPrice: 100,
  exitPrice: null,
  ltp: 101,
  entryTime: '2026-10-20T04:00:00.000Z',
  exitTime: null,
  status: 'OPEN',
  pnl: 1,
  pnlPercent: 1,
  openedBy: 'MANUAL',
  closedBy: null,
  strategy: null,
  closeNote: null,
  ...over,
});

describe('livePortfolio wire client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the live dashboard and journal endpoints', async () => {
    (api.get as Mock).mockResolvedValueOnce({ data: { summary: {} } });
    expect(await getLiveDashboard()).toEqual({ summary: {} });
    expect(api.get).toHaveBeenLastCalledWith('/portfolio/live/dashboard');

    (api.get as Mock).mockResolvedValueOnce({ data: { trades: [row()], total: 1 } });
    const j = await getLiveJournal();
    expect(api.get).toHaveBeenLastCalledWith('/portfolio/live/journal');
    expect(j.total).toBe(1);
  });

  it('a malformed journal payload degrades to an empty list', async () => {
    (api.get as Mock).mockResolvedValueOnce({ data: {} });
    expect(await getLiveJournal()).toEqual({ trades: [], total: 0 });
  });
});

describe('livePortfolio view helpers', () => {
  const rows = [
    row({ id: 'open', pnl: 30 }),
    row({ id: 'agent', status: 'CLOSED', closedBy: 'AGENT', pnl: -50, exitTime: '2026-10-21T04:00:00.000Z' }),
    row({ id: 'manual', status: 'CLOSED', closedBy: 'MANUAL', pnl: 120, exitTime: '2026-10-21T05:00:00.000Z' }),
  ];

  it('labels who closed a trade', () => {
    expect(closedByLabel('AGENT')).toBe('AI agent');
    expect(closedByLabel('MODEL')).toBe('Model');
    expect(closedByLabel(null)).toBe('Open');
  });

  it('filters by status and by closer', () => {
    expect(filterLiveTrades(rows, 'ALL')).toHaveLength(3);
    expect(filterLiveTrades(rows, 'OPEN').map((r) => r.id)).toEqual(['open']);
    expect(filterLiveTrades(rows, 'CLOSED')).toHaveLength(2);
    expect(filterLiveTrades(rows, 'AGENT').map((r) => r.id)).toEqual(['agent']);
  });

  it('totals realised vs unrealised and the win rate over closed trades', () => {
    expect(liveTotals(rows)).toEqual({ realised: 70, unrealised: 30, closed: 2, open: 1, wins: 1, winRate: 50 });
    expect(liveTotals([]).winRate).toBe(0);
  });

  it('lastN keeps the tail of a series', () => {
    expect(lastN([1, 2, 3, 4], 2)).toEqual([3, 4]);
    expect(lastN([1], 5)).toEqual([1]);
  });
});
