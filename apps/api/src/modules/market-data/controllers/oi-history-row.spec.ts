import { oiHistoryRow } from './oi-history-row';

describe('oiHistoryRow (GET /api/market-data/instruments/:token/oi row mapping)', () => {
  const ts = new Date('2026-10-12T04:40:00Z');

  it('keeps numbers as numbers, converting BigInt/Decimal-like columns', () => {
    expect(oiHistoryRow({ oi: BigInt(1200), oiChange: -50, volume: BigInt(30), timestamp: ts })).toEqual({ oi: 1200, oiChange: -50, volume: 30, timestamp: ts });
  });

  it('a NULL oiChange (no baseline) stays null, never 0', () => {
    expect(oiHistoryRow({ oi: 1200, oiChange: null, volume: 30, timestamp: ts }).oiChange).toBeNull();
  });
});
