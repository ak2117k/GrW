import { useEffect, useMemo, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';
import type { StrongZone } from '@/types';
import { classifyZoneTiers, type ZoneTierAnnotation } from './classifyZoneTiers';

interface ChartZoneOverlayProps {
  candleSeries: ISeriesApi<'Candlestick'> | null;
  zones: StrongZone[];
  /** Live price — required to compute nearest (immediate) walls. */
  ltp: number;
}

interface StyleSpec {
  color: string;
  lineWidth: 1 | 2 | 3;
  // 0 = solid, 1 = dotted, 2 = dashed (lightweight-charts LineStyle).
  lineStyle: 0 | 1 | 2;
}

/** Hue encodes role: red = resistance, green = support. */
function baseColor(zone: StrongZone): string {
  return zone.type === 'resistance' ? '#ef4444' : '#22c55e';
}

/**
 * Tier drives emphasis; hue always encodes role (red = resistance,
 * green = support). We modulate alpha, never hue.
 *   immediate → solid, 3px, full opacity   (the next wall)
 *   major     → solid, 2px, ~80% opacity    (structural STRONG wall)
 *   context   → dashed, 1px, ~40% opacity   (other MEDIUM levels)
 */
function styleForTier(a: ZoneTierAnnotation): StyleSpec {
  const base = baseColor(a.zone);
  if (a.tier === 'immediate') return { color: base, lineWidth: 3, lineStyle: 0 };
  if (a.tier === 'major') return { color: `${base}cc`, lineWidth: 2, lineStyle: 0 };
  // Forming = freshly-flipped, unproven: dotted + amber so it reads as tentative.
  if (a.tier === 'forming') return { color: '#f59e0b', lineWidth: 1, lineStyle: 1 };
  return { color: `${base}66`, lineWidth: 1, lineStyle: 2 };
}

/** e.g. "IMM R 2,512 (+0.4%)", "MAJOR S 2,440 (-2.9%)", "S55 R 2,540". */
function tierTitle(a: ZoneTierAnnotation): string {
  const role = a.zone.type === 'resistance' ? 'R' : 'S';
  // Swap-aware prefix preserved from the original overlay.
  const flip =
    a.zone.flippedAt && a.zone.wasType
      ? a.zone.wasType === 'support'
        ? 'S→R '
        : 'R→S '
      : '';
  let tag: string;
  if (a.tier === 'forming') tag = 'FORMING';
  else if (a.isImmediate && a.isMajor) tag = 'IMM·MAJOR';
  else if (a.isImmediate) tag = 'IMM';
  else if (a.isMajor) tag = 'MAJOR';
  else tag = `S${a.zone.strength}`; // context keeps the strength score
  const priceStr = a.refPrice.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const sign = a.distancePct >= 0 ? '+' : '';
  // For context lines the strength tag already carries info; show distance for
  // immediate/major where it drives the "room to target" judgement.
  const dist =
    a.isImmediate || a.isMajor || a.tier === 'forming'
      ? ` (${sign}${a.distancePct.toFixed(1)}%)`
      : '';
  return `${flip}${tag} ${role} ${priceStr}${dist}`;
}

/**
 * Wrap every lightweight-charts call in try/catch. The library throws
 * "Object is disposed" errors when the chart is torn down mid-cycle (fast
 * unmount, symbol switch, fullscreen toggle, StrictMode double-mount —
 * we have a memory of this exact issue from CandlestickChart.tsx).
 */
function safeCreatePriceLine(
  series: ISeriesApi<'Candlestick'>,
  options: Parameters<ISeriesApi<'Candlestick'>['createPriceLine']>[0],
): IPriceLine | null {
  try {
    return series.createPriceLine(options);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ChartZoneOverlay] createPriceLine failed (likely disposed):', err);
    return null;
  }
}

function safeRemovePriceLine(
  series: ISeriesApi<'Candlestick'>,
  line: IPriceLine,
): void {
  try {
    series.removePriceLine(line);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ChartZoneOverlay] removePriceLine failed (likely disposed):', err);
  }
}

/**
 * Renders immediate/major/context S/R as horizontal price lines on the
 * candlestick series. Pure side-effect component — returns null.
 *
 * Each zone draws ONE labeled line at its reachable edge (`refPrice`), plus —
 * for bands (isLine === false) — a thin dashed unlabeled line at the far edge
 * so the band's width is visible. WEAK + straddle zones are dropped by
 * classifyZoneTiers.
 *
 * On every input change we tear down previously-drawn lines and recreate.
 * Cheap (≤ ~20 lines for top 5+5 zones) and avoids stale reconciliation bugs.
 */
export default function ChartZoneOverlay({
  candleSeries,
  zones,
  ltp,
}: ChartZoneOverlayProps) {
  const linesRef = useRef<IPriceLine[]>([]);

  const annotations = useMemo(
    () => classifyZoneTiers(zones, ltp),
    [zones, ltp],
  );

  // Redraw only when the VISIBLE output changes — tier assignment, level
  // price, or the displayed distance-% (rendered to 1 decimal). `ltp` itself
  // ticks several times per second; without this the effect would tear down
  // and recreate every price line on each tick for no visible change.
  const drawKey = useMemo(
    () =>
      annotations
        .map(
          (a) =>
            `${a.zone.id}:${a.tier}:${a.refPrice}:${a.distancePct.toFixed(1)}`,
        )
        .join('|'),
    [annotations],
  );

  useEffect(() => {
    if (!candleSeries) return;
    const series = candleSeries;

    // 1. Tear down anything drawn previously.
    for (const line of linesRef.current) {
      safeRemovePriceLine(series, line);
    }
    linesRef.current = [];

    // 2. Draw tier-annotated zones.
    for (const a of annotations) {
      const style = styleForTier(a);

      const labeled = safeCreatePriceLine(series, {
        price: a.refPrice,
        color: style.color,
        lineWidth: style.lineWidth,
        lineStyle: style.lineStyle,
        axisLabelVisible: true,
        title: tierTitle(a),
      });
      if (labeled) linesRef.current.push(labeled);

      // Band: draw the far edge thin + dashed + unlabeled to show width.
      if (!a.zone.isLine) {
        const farEdge =
          a.zone.type === 'resistance' ? a.zone.upper : a.zone.lower;
        // Defensive: refPrice === farEdge only for a degenerate zero-width
        // band (isLine === false guarantees upper !== lower for real bands).
        if (farEdge !== a.refPrice) {
          const edge = safeCreatePriceLine(series, {
            price: farEdge,
            color: `${baseColor(a.zone)}66`,
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: false,
            title: '',
          });
          if (edge) linesRef.current.push(edge);
        }
      }
    }

    // 3. Cleanup on unmount or before the next update.
    return () => {
      for (const line of linesRef.current) {
        safeRemovePriceLine(series, line);
      }
      linesRef.current = [];
    };
    // `annotations` is referenced but intentionally omitted: it is memoised on
    // [zones, ltp] and `drawKey` is derived from it, so whenever the visible
    // output changes `drawKey` changes and `annotations` is already fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleSeries, drawKey]);

  return null;
}
