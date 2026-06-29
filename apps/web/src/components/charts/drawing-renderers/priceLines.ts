import type { IPriceLine, ISeriesApi, LineStyle as LWLineStyle } from 'lightweight-charts';
import type {
  HorizontalLineDrawing, HorizontalZoneDrawing, FibDrawing, Drawing,
} from '@/types/drawings';
import { FIB_LEVEL_COLORS } from '@/types/drawings';

function lwLineStyle(s: Drawing['lineStyle']): LWLineStyle {
  switch (s) {
    case 'dashed': return 2 as LWLineStyle;
    case 'dotted': return 4 as LWLineStyle;
    default: return 0 as LWLineStyle;
  }
}

function formatPriceLabel(price: number): string {
  return price.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

export function buildHLine(
  series: ISeriesApi<'Candlestick'>,
  d: HorizontalLineDrawing,
): IPriceLine[] {
  return [
    series.createPriceLine({
      price: d.price,
      color: d.color,
      lineWidth: d.lineWidth,
      lineStyle: lwLineStyle(d.lineStyle),
      axisLabelVisible: true,
      title: d.label ?? formatPriceLabel(d.price),
    }),
  ];
}

export function buildHZone(
  series: ISeriesApi<'Candlestick'>,
  d: HorizontalZoneDrawing,
): IPriceLine[] {
  return [
    series.createPriceLine({
      price: d.upper,
      color: d.color,
      lineWidth: d.lineWidth,
      lineStyle: lwLineStyle(d.lineStyle),
      axisLabelVisible: true,
      title: d.label ? `${d.label} ↑` : formatPriceLabel(d.upper),
    }),
    series.createPriceLine({
      price: d.lower,
      color: d.color,
      lineWidth: d.lineWidth,
      lineStyle: lwLineStyle(d.lineStyle),
      axisLabelVisible: true,
      title: d.label ? `${d.label} ↓` : formatPriceLabel(d.lower),
    }),
  ];
}

export function buildFib(
  series: ISeriesApi<'Candlestick'>,
  d: FibDrawing,
): IPriceLine[] {
  const span = d.p2.price - d.p1.price;
  return d.levels.map((ratio) => {
    const price = d.p1.price + span * ratio;
    return series.createPriceLine({
      price,
      color: FIB_LEVEL_COLORS[String(ratio)] ?? d.color,
      lineWidth: 1,
      lineStyle: lwLineStyle(d.lineStyle),
      axisLabelVisible: true,
      title: `${ratio.toFixed(3)} — ${formatPriceLabel(price)}`,
    });
  });
}

export function reconcileHLine(lines: IPriceLine[], d: HorizontalLineDrawing): boolean {
  if (lines.length !== 1) return false;
  lines[0].applyOptions({
    price: d.price,
    color: d.color,
    lineWidth: d.lineWidth,
    lineStyle: lwLineStyle(d.lineStyle),
    title: d.label ?? formatPriceLabel(d.price),
  });
  return true;
}

export function reconcileHZone(lines: IPriceLine[], d: HorizontalZoneDrawing): boolean {
  if (lines.length !== 2) return false;
  lines[0].applyOptions({
    price: d.upper, color: d.color, lineWidth: d.lineWidth,
    lineStyle: lwLineStyle(d.lineStyle),
    title: d.label ? `${d.label} ↑` : formatPriceLabel(d.upper),
  });
  lines[1].applyOptions({
    price: d.lower, color: d.color, lineWidth: d.lineWidth,
    lineStyle: lwLineStyle(d.lineStyle),
    title: d.label ? `${d.label} ↓` : formatPriceLabel(d.lower),
  });
  return true;
}

export function reconcileFib(lines: IPriceLine[], d: FibDrawing): boolean {
  if (lines.length !== d.levels.length) return false;
  const span = d.p2.price - d.p1.price;
  d.levels.forEach((ratio, i) => {
    const price = d.p1.price + span * ratio;
    lines[i].applyOptions({
      price,
      color: FIB_LEVEL_COLORS[String(ratio)] ?? d.color,
      title: `${ratio.toFixed(3)} — ${formatPriceLabel(price)}`,
    });
  });
  return true;
}
