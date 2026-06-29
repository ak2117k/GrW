import { describe, it, expect } from 'vitest';
import { buildConverter } from './useCoordinateConverter';

function mockChart(timeMap: Record<number, number | null>) {
  return {
    timeScale: () => ({
      timeToCoordinate: (t: number) => timeMap[t] ?? null,
      coordinateToTime: (x: number) => {
        for (const [t, coord] of Object.entries(timeMap)) {
          if (coord === x) return Number(t);
        }
        return null;
      },
    }),
  };
}

function mockSeries(priceMap: Record<number, number | null>) {
  return {
    priceToCoordinate: (p: number) => priceMap[p] ?? null,
    coordinateToPrice: (y: number) => {
      for (const [p, coord] of Object.entries(priceMap)) {
        if (coord === y) return Number(p);
      }
      return null;
    },
  };
}

describe('buildConverter', () => {
  it('round-trips real time through compressed time', () => {
    const realTimeMap = new Map<number, number>([
      [1000, 1000],
      [1015, 2000],
    ]);
    const chart = mockChart({ 1000: 100, 1015: 200 });
    const series = mockSeries({});

    const conv = buildConverter(chart as any, series as any, realTimeMap);
    expect(conv.timeToX(1000)).toBe(100);
    expect(conv.timeToX(2000)).toBe(200);
  });

  it('returns null for real time not in the compressed map', () => {
    const realTimeMap = new Map<number, number>([[1000, 1000]]);
    const chart = mockChart({ 1000: 100 });
    const series = mockSeries({});
    const conv = buildConverter(chart as any, series as any, realTimeMap);
    expect(conv.timeToX(9999)).toBeNull();
  });

  it('xToTime returns real time for a known compressed coordinate', () => {
    const realTimeMap = new Map<number, number>([[1015, 2000]]);
    const chart = mockChart({ 1015: 200 });
    const series = mockSeries({});
    const conv = buildConverter(chart as any, series as any, realTimeMap);
    expect(conv.xToTime(200)).toBe(2000);
  });

  it('priceToY delegates to series', () => {
    const chart = mockChart({});
    const series = mockSeries({ 150: 50 });
    const conv = buildConverter(chart as any, series as any, new Map());
    expect(conv.priceToY(150)).toBe(50);
  });

  it('yToPrice delegates to series', () => {
    const chart = mockChart({});
    const series = mockSeries({ 150: 50 });
    const conv = buildConverter(chart as any, series as any, new Map());
    expect(conv.yToPrice(50)).toBe(150);
  });
});
