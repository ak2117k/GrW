/**
 * Pure mapping from a candle series to the flat `PatternMarkerDto[]` wire shape.
 *
 * This is the ONLY place detector output is translated into the endpoint's
 * contract, so it is factored out of the controller and unit-tested directly on
 * synthetic candles — no Angel One / DI mocking required. Detector indices
 * (`hit.index`, `hit.first.index`, …) are positions INTO `candles`, so we map
 * each straight back to `candles[i].time` (epoch ms) for exact alignment.
 */

import type { Candle } from './swing-points';
import { findCandlestickPatterns } from './candlestick';
import { findChartPatterns } from './chart-patterns';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';

/** Detect every candlestick + chart pattern in `candles` and flatten to markers. */
export function buildPatternMarkers(candles: Candle[]): PatternMarkerDto[] {
  const markers: PatternMarkerDto[] = [];

  for (const hit of findCandlestickPatterns(candles)) {
    markers.push({
      category: 'CANDLESTICK',
      name: hit.name,
      bias: hit.bias,
      time: candles[hit.index].time,
      points: [],
      necklinePrice: null,
      confirmed: null,
      confirmTime: null,
    });
  }

  for (const hit of findChartPatterns(candles)) {
    markers.push({
      category: 'CHART',
      name: hit.name,
      bias: hit.bias,
      time: candles[hit.second.index].time,
      points: [candles[hit.first.index].time, candles[hit.second.index].time],
      necklinePrice: hit.necklinePrice,
      confirmed: hit.confirmed,
      confirmTime: hit.confirmIndex != null ? candles[hit.confirmIndex].time : null,
    });
  }

  return markers;
}
