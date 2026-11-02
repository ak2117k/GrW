import { withoutBlinkCloses } from './blink-closes';
import type { LiveTrackerRow } from '../repositories/live-trades.repository';

const at = (m: number) => new Date(Date.parse('2026-10-20T04:00:00Z') + m * 60_000);
const row = (o: Partial<LiveTrackerRow>): LiveTrackerRow => ({
  id: 'x', symbol: 'IDEA-EQ', exchange: 'NSE', token: '14366', kind: 'HOLDING', entryPrice: 13.11, qty: 100,
  entryTime: at(0), exitPrice: 12, exitTime: at(60), status: 'CLOSED', lastLtp: 12, pnl: -111, pnlPercent: -8.5, ...o,
});

describe('withoutBlinkCloses', () => {
  it('drops a close re-opened 5 min later at the same price and qty (the holding continued)', () => {
    const out = withoutBlinkCloses([row({ id: 'a' }), row({ id: 'b', entryTime: at(65), exitTime: null, status: 'OPEN', pnl: -128 })]);
    expect(out.map((r) => r.id)).toEqual(['b']);
  });
  it('a chain of blinks keeps only the last row', () => {
    const out = withoutBlinkCloses([
      row({ id: 'a' }), row({ id: 'b', entryTime: at(70), exitTime: at(200) }), row({ id: 'c', entryTime: at(210), exitTime: null, status: 'OPEN' }),
    ]);
    expect(out.map((r) => r.id)).toEqual(['c']);
  });
  it('keeps real exits: re-entry after 35 min, at another price, or with another qty', () => {
    expect(withoutBlinkCloses([row({ id: 'a' }), row({ id: 'b', entryTime: at(100) })]).map((r) => r.id)).toEqual(['a', 'b']);
    expect(withoutBlinkCloses([row({ id: 'a' }), row({ id: 'b', entryTime: at(65), entryPrice: 11 })]).map((r) => r.id)).toEqual(['a', 'b']);
    expect(withoutBlinkCloses([row({ id: 'a' }), row({ id: 'b', entryTime: at(65), qty: 50 })]).map((r) => r.id)).toEqual(['a', 'b']);
  });
  it('drops CLOSED rows with no cost (entry 0) and keeps other tokens apart', () => {
    expect(withoutBlinkCloses([row({ id: 'z', entryPrice: 0, pnl: 9000 })])).toEqual([]);
    expect(withoutBlinkCloses([row({ id: 'a' }), row({ id: 'b', token: '999', entryTime: at(65) })]).map((r) => r.id)).toEqual(['a', 'b']);
  });
});
