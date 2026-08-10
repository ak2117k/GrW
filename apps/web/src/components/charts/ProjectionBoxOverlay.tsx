import { useEffect, useMemo, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';
import { withLiveSeries } from './chart-lifecycle';
import {
  projectionBands,
  projectionBoxLines,
  type ProjectionBand,
  type ProjectionBoxLine,
  type ProjectionZonesView,
} from './projectionBoxView';
import { ProjectionBandPrimitive } from './projectionBandPrimitive';

interface ProjectionBoxOverlayProps {
  series: ISeriesApi<'Candlestick'> | null;
  /**
   * The SAME view object the Setup & Context card renders. Passing the derived
   * view rather than the raw `ProjectionZones` is what makes it impossible for
   * the chart to draw a box while the card says "unavailable".
   */
  view: ProjectionZonesView;
}

/**
 * Wrap every lightweight-charts call. The library throws "Object is disposed"
 * when the chart is torn down mid-cycle (fast unmount, symbol switch,
 * fullscreen toggle, StrictMode double-mount), and a call that partially
 * executes before throwing has already queued a repaint against a dead canvas
 * — so we gate on the disposal registry rather than only catching the throw.
 * See `chart-lifecycle.ts`.
 */
function safeCreatePriceLine(
  series: ISeriesApi<'Candlestick'>,
  options: Parameters<ISeriesApi<'Candlestick'>['createPriceLine']>[0],
): IPriceLine | null {
  let line: IPriceLine | null = null;
  withLiveSeries(series, (s) => {
    line = s.createPriceLine(options);
  });
  return line;
}

/**
 * Renders the projection entry boxes on the candlestick series.
 *
 * The box is drawn as its two edges — the broken level and the far edge where
 * entry stops clearing the R:R floor — in the direction's hue: green for an
 * up-break, red for a down-break. `armed` draws faded and dashed, `confirmed`
 * draws full-strength and solid, so the state is legible without reading a
 * label. The target is a SEPARATE dashed line, never a box edge, so the region
 * you may enter and the price you are projecting to can never be read as one
 * shape.
 *
 * Pure side-effect component — returns null. Every drawable decision already
 * happened in `projectionBoxView`; this file only draws.
 *
 * On every visible change we tear down previously-drawn lines and recreate.
 * Cheap (≤ 8 lines for both sides) and avoids stale reconciliation bugs.
 */
export default function ProjectionBoxOverlay({
  series,
  view,
}: ProjectionBoxOverlayProps) {
  const linesRef = useRef<IPriceLine[]>([]);
  const bandRef = useRef<ProjectionBandPrimitive | null>(null);

  const lines = useMemo<ProjectionBoxLine[]>(() => projectionBoxLines(view), [view]);
  const bands = useMemo<ProjectionBand[]>(() => projectionBands(view), [view]);

  // Redraw only when the VISIBLE output changes. `view` is a fresh object on
  // every 60s poll even when nothing moved; without this the effect would tear
  // down and recreate every price line for no visible change.
  const drawKey = useMemo(
    () =>
      lines
        .map((l) => `${l.side}:${l.role}:${l.value}:${l.color}:${l.lineStyle}:${l.label}`)
        .join('|'),
    [lines],
  );

  /**
   * The filled travel bands live in a series PRIMITIVE, attached once and
   * updated in place. Attaching/detaching per poll would rebuild the renderer
   * on every 60s tick, and a primitive left attached to a disposed series is
   * the leak this ref exists to prevent.
   */
  useEffect(() => {
    if (!series) return;
    const target = series;
    const primitive = new ProjectionBandPrimitive();
    bandRef.current = primitive;
    // Called directly, NOT through an optional chain on a cast. The previous
    // form silently drew nothing if the method was ever absent, which is
    // indistinguishable from "no projection qualified" — the one confusion this
    // whole feature exists to prevent. A missing method must be loud.
    withLiveSeries(target, (s) => s.attachPrimitive(primitive));
    return () => {
      withLiveSeries(target, (s) => s.detachPrimitive(primitive));
      bandRef.current = null;
    };
  }, [series]);

  useEffect(() => {
    bandRef.current?.setBands(bands);
  }, [bands]);

  useEffect(() => {
    if (!series) return;
    const target = series;

    // 1. Tear down anything drawn previously.
    withLiveSeries(target, (s) => {
      for (const line of linesRef.current) s.removePriceLine(line);
    });
    linesRef.current = [];

    // 2. Draw the current boxes. An empty list is a legitimate state —
    //    loading, failed and "nothing qualified" all draw nothing, and the
    //    card is what tells those three apart in words.
    for (const line of lines) {
      const drawn = safeCreatePriceLine(target, {
        price: line.value,
        color: line.color,
        lineWidth: line.lineWidth,
        lineStyle: line.lineStyle,
        axisLabelVisible: line.axisLabelVisible,
        title: line.label,
      });
      if (drawn) linesRef.current.push(drawn);
    }

    // 3. Cleanup on unmount or before the next update. A primitive left behind
    //    here outlives the symbol it described, so this is not optional.
    return () => {
      withLiveSeries(target, (s) => {
        for (const line of linesRef.current) s.removePriceLine(line);
      });
      linesRef.current = [];
    };
    // `lines` is referenced but intentionally omitted: it is memoised on
    // [view] and `drawKey` is derived from it, so whenever the visible output
    // changes `drawKey` changes and `lines` is already fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, drawKey]);

  return null;
}
