import { useEffect, useRef } from 'react';
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  SeriesMarker,
  SeriesMarkerPosition,
  SeriesMarkerShape,
  Time,
} from 'lightweight-charts';
import type { PatternMarker } from '@/hooks/usePatterns';
import { mapPatternsToChartTime } from './mapPatternsToChartTime';

interface PatternOverlayProps {
  series: ISeriesApi<'Candlestick'> | null;
  // Kept for parity with the other overlays / future needs; markers + price
  // lines are drawn on the series, so `chart` isn't read directly.
  chart: IChartApi | null;
  patterns: PatternMarker[];
  // Compressed-time → real-seconds map the chart is currently plotting on.
  realTimeMap: Map<number, number>;
}

// Bias → colour. Green bullish, red bearish, amber for neutral (doji).
function biasColor(bias: PatternMarker['bias']): string {
  if (bias === 'BULLISH') return '#22c55e';
  if (bias === 'BEARISH') return '#ef4444';
  return '#f59e0b';
}

const LABELS: Record<string, string> = {
  BULLISH_ENGULFING: 'Bull Engulf',
  BEARISH_ENGULFING: 'Bear Engulf',
  HAMMER: 'Hammer',
  INVERTED_HAMMER: 'Inv Hammer',
  HANGING_MAN: 'Hanging Man',
  SHOOTING_STAR: 'Shooting Star',
  DOJI: 'Doji',
  MORNING_STAR: 'Morning Star',
  EVENING_STAR: 'Evening Star',
  PIERCING: 'Piercing',
  DARK_CLOUD_COVER: 'Dark Cloud',
  DOUBLE_TOP: 'Double Top',
  DOUBLE_BOTTOM: 'Double Bottom',
  HEAD_AND_SHOULDERS: 'H&S',
  INVERSE_HEAD_AND_SHOULDERS: 'Inv H&S',
  TRIPLE_TOP: 'Triple Top',
  TRIPLE_BOTTOM: 'Triple Bottom',
};

/** Human-friendly short label; unknown names get Title-Cased. */
function shortLabel(name: string): string {
  const known = LABELS[name];
  if (known) return known;
  return name
    .split('_')
    .map((w) => (w ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/**
 * Draws detected patterns onto the candle series:
 *
 *  - CANDLESTICK → one marker at the (compressed) anchor time. BULLISH is a
 *    green up-arrow below the bar, BEARISH a red down-arrow above, NEUTRAL an
 *    amber circle above.
 *  - CHART → a marker at EACH mapped peak/trough (arrow coloured by bias) plus
 *    a dashed neckline price line ('neckline'). The label carries a ' ✓' when
 *    the pattern is confirmed.
 *
 * `setMarkers` REPLACES all markers, so every marker (candlestick + chart) is
 * collected into ONE array, sorted ascending by time (lightweight-charts
 * requires that), and set in a single call. Cleanup clears markers and removes
 * every created price line. Pure side-effect — renders null.
 */
export default function PatternOverlay({
  series,
  patterns,
  realTimeMap,
}: PatternOverlayProps) {
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!series) return;
    const s = series;

    const mapped = mapPatternsToChartTime(patterns, realTimeMap);
    const markers: SeriesMarker<Time>[] = [];

    for (const m of mapped) {
      const p = m.pattern;
      const color = biasColor(p.bias);

      if (p.category === 'CANDLESTICK') {
        if (m.anchorTime === null) continue;
        const position: SeriesMarkerPosition =
          p.bias === 'BULLISH' ? 'belowBar' : 'aboveBar';
        const shape: SeriesMarkerShape =
          p.bias === 'BULLISH'
            ? 'arrowUp'
            : p.bias === 'BEARISH'
              ? 'arrowDown'
              : 'circle';
        markers.push({
          time: m.anchorTime as Time,
          position,
          color,
          shape,
          text: shortLabel(p.name),
        });
        continue;
      }

      // CHART pattern: mark each peak/trough + draw the neckline.
      const label = shortLabel(p.name) + (p.confirmed ? ' ✓' : '');
      const position: SeriesMarkerPosition =
        p.bias === 'BULLISH' ? 'belowBar' : 'aboveBar';
      const shape: SeriesMarkerShape =
        p.bias === 'BULLISH' ? 'arrowUp' : 'arrowDown';
      for (const t of m.pointTimes) {
        markers.push({ time: t as Time, position, color, shape, text: label });
      }

      if (p.necklinePrice !== null) {
        try {
          const line = s.createPriceLine({
            price: p.necklinePrice,
            color,
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: 'neckline',
          });
          linesRef.current.push(line);
        } catch {
          /* chart may be disposed mid-cycle */
        }
      }
    }

    // Markers MUST be sorted ascending by time before setMarkers.
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    try {
      s.setMarkers(markers);
    } catch {
      /* disposed */
    }

    return () => {
      try {
        s.setMarkers([]);
      } catch {
        /* ignore */
      }
      for (const line of linesRef.current) {
        try {
          s.removePriceLine(line);
        } catch {
          /* ignore */
        }
      }
      linesRef.current = [];
    };
  }, [series, patterns, realTimeMap]);

  return null;
}
