import { describe, it, expect } from 'vitest';
import { buildOhlcRows, OHLC_COLUMNS, type DailyOhlc } from './exportOhlc';

function bar(o: Partial<DailyOhlc> = {}): DailyOhlc {
  return {
    date: '2026-07-11',
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    ...o,
  };
}

describe('buildOhlcRows', () => {
  it('header lists the 5 columns in order', () => {
    const { header } = buildOhlcRows([]);
    expect(header).toEqual(['Date', 'Open', 'High', 'Low', 'Close']);
    expect(header).toEqual([...OHLC_COLUMNS]);
  });

  it('empty input yields an empty body', () => {
    const { body } = buildOhlcRows([]);
    expect(body).toEqual([]);
  });

  it('a populated row maps every cell, rounding numbers to 2dp', () => {
    const { body } = buildOhlcRows([
      bar({
        date: '2026-07-13',
        open: 1500.5,
        high: 1620.256, // rounds to 2dp
        low: 1480.001, // rounds to 2dp
        close: 1600,
      }),
    ]);
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual(['2026-07-13', 1500.5, 1620.26, 1480, 1600]);
  });

  it('preserves row order across multiple bars', () => {
    const { body } = buildOhlcRows([
      bar({ date: '2026-07-11', close: 105 }),
      bar({ date: '2026-07-12', close: 108 }),
    ]);
    expect(body.map((r) => r[0])).toEqual(['2026-07-11', '2026-07-12']);
    expect(body[1][4]).toBe(108);
  });
});
