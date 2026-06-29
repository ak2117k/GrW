import { useMemo } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';

export interface CoordinateConverter {
  timeToX: (realSec: number) => number | null;
  xToTime: (px: number) => number | null;
  priceToY: (price: number) => number | null;
  yToPrice: (px: number) => number | null;
}

export function buildConverter(
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  realTimeMap: Map<number, number>,
): CoordinateConverter {
  const reverseMap = new Map<number, number>();
  for (const [compressed, real] of realTimeMap) {
    reverseMap.set(real, compressed);
  }

  return {
    timeToX: (realSec) => {
      const compressed = reverseMap.get(realSec);
      if (compressed === undefined) return null;
      const coord = chart.timeScale().timeToCoordinate(compressed as Time);
      return coord;
    },
    xToTime: (px) => {
      const compressed = chart.timeScale().coordinateToTime(px);
      if (compressed === null) return null;
      const real = realTimeMap.get(compressed as number);
      return real ?? (compressed as number);
    },
    priceToY: (price) => series.priceToCoordinate(price),
    yToPrice: (px) => series.coordinateToPrice(px),
  };
}

export function useCoordinateConverter(
  chart: IChartApi | null,
  series: ISeriesApi<'Candlestick'> | null,
  realTimeMap: Map<number, number>,
): CoordinateConverter | null {
  return useMemo(() => {
    if (!chart || !series) return null;
    return buildConverter(chart, series, realTimeMap);
  }, [chart, series, realTimeMap]);
}
