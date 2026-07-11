import { describe, it, expect } from 'vitest';
import { buildTrackerRows, TRACKER_COLUMNS } from './exportTrackers';
import type { TradeTracker } from '@/hooks/useTradeTrackers';

function tracker(o: Partial<TradeTracker> = {}): TradeTracker {
  return {
    id: 't1',
    symbol: 'RELIANCE',
    exchange: 'NSE',
    token: '2885',
    kind: 'HOLDING',
    entryPrice: 100,
    qty: 10,
    entryTime: '2026-07-11T03:45:00.000Z',
    exitPrice: null,
    exitTime: null,
    status: 'OPEN',
    holdingHigh: null,
    holdingLow: null,
    dayHigh: null,
    dayLow: null,
    lastLtp: null,
    pnl: null,
    pnlPercent: null,
    updatedAt: '2026-07-11T03:45:00.000Z',
    ...o,
  };
}

describe('buildTrackerRows', () => {
  it('header lists all 14 columns in order', () => {
    const { header } = buildTrackerRows([]);
    expect(header).toEqual([
      'Symbol', 'Exch', 'Kind', 'Entry', 'Qty', 'Exit', 'Exit Time',
      'Holding High', 'Holding Low', 'Day High', 'Day Low', 'P&L', 'P&L %', 'Status',
    ]);
    expect(header).toEqual([...TRACKER_COLUMNS]);
  });

  it('empty input yields an empty body', () => {
    const { body } = buildTrackerRows([]);
    expect(body).toEqual([]);
  });

  it('a fully-populated CLOSED row maps every cell', () => {
    const row = tracker({
      symbol: 'INFY',
      exchange: 'NSE',
      kind: 'POSITION',
      entryPrice: 1500.5,
      qty: 25,
      exitPrice: 1620.256, // rounds to 2dp
      exitTime: '2026-07-11T09:15:30.000Z',
      holdingHigh: 1650,
      holdingLow: 1480,
      dayHigh: 1625,
      dayLow: 1590,
      pnl: 2993.9,
      pnlPercent: 7.98,
      status: 'CLOSED',
    });
    const { body } = buildTrackerRows([row]);
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual([
      'INFY', 'NSE', 'POSITION', 1500.5, 25, 1620.26, '2026-07-11 09:15',
      1650, 1480, 1625, 1590, 2993.9, '+7.98%', 'CLOSED',
    ]);
  });

  it('null numeric cells render as em-dash and null exitTime as empty string', () => {
    const { body } = buildTrackerRows([tracker({ status: 'OPEN' })]);
    const [r] = body;
    // Exit (index 5), Holding H/L, Day H/L, P&L → em-dash
    expect(r[5]).toBe('—');
    expect(r[7]).toBe('—');
    expect(r[8]).toBe('—');
    expect(r[9]).toBe('—');
    expect(r[10]).toBe('—');
    expect(r[11]).toBe('—');
    // P&L % (index 12) → em-dash when null
    expect(r[12]).toBe('—');
    // Exit Time (index 6) → '' when null
    expect(r[6]).toBe('');
    // Status distinguishes OPEN
    expect(r[13]).toBe('OPEN');
  });

  it('negative P&L % keeps its sign, positive gets a leading +', () => {
    const { body } = buildTrackerRows([
      tracker({ pnlPercent: -3.2 }),
      tracker({ pnlPercent: 5 }),
    ]);
    expect(body[0][12]).toBe('-3.20%');
    expect(body[1][12]).toBe('+5.00%');
  });
});
