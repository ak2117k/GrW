import type { PositionMarker } from '@/services/chartTrades.service';

/**
 * Colours: entry is a green ▲ (positions are LONG); a partial book is a neutral
 * amber ◐; an exit is green when the trade was in profit (pnlPct ≥ 0) and red
 * when it was a loss.
 */
export const ENTRY_COLOR = '#22c55e';
export const PARTIAL_COLOR = '#f59e0b';
export const EXIT_PROFIT_COLOR = '#22c55e';
export const EXIT_LOSS_COLOR = '#ef4444';

export type TradeMarkerKind = 'entry' | 'partial' | 'exit';

/**
 * A flat, chart-agnostic marker descriptor. `timeMs` is still REAL epoch MS —
 * the overlay maps it onto the compressed axis at render time. Pure data, so
 * the entry/partial/exit fan-out, glyphs, colours and tooltip text can be
 * unit-tested without a chart.
 */
export interface TradeMarkerDescriptor {
  key: string;
  positionId: string;
  kind: TradeMarkerKind;
  glyph: string; // '▲' | '◐' | '●'
  color: string;
  timeMs: number;
  price: number;
  /** Primary single-line tooltip. */
  tooltip: string;
  /** Optional second line shown on hover (entry: target/stop %, exit: reason). */
  detail?: string;
}

/** `1234.5` → `₹1,234.5` (Indian-locale grouping, up to 2 dp, no trailing zeros). */
export function formatPrice(price: number): string {
  return `₹${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** `-10` → `-10.0%`, `5.25` → `+5.3%`, `0` → `+0.0%`. Always signed, 1 dp. */
export function formatSignedPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '-';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Tooltip for an entry: "Entered ₹<price> · from <provenance>". */
export function formatEntryTooltip(price: number, provenance: string): string {
  return `Entered ${formatPrice(price)} · from ${provenance}`;
}

/**
 * Hover detail for an entry: "Target +<t>% · Stop −<s>%". These are LONG paper
 * positions and the backend sends both magnitudes positive, so we render target
 * as upside (+) and stop as downside (−) to match what the levels actually mean.
 */
export function formatEntryDetail(targetPct: number, stopPct: number): string {
  return `Target ${formatSignedPct(Math.abs(targetPct))} · Stop ${formatSignedPct(-Math.abs(stopPct))}`;
}

/** Tooltip for a partial book: "Booked <fraction%> at ₹<price>" (0.5 → "50%"). */
export function formatPartialTooltip(fraction: number, price: number): string {
  return `Booked ${Math.round(fraction * 100)}% at ${formatPrice(price)}`;
}

/** Tooltip for an exit: "Exited ₹<price> · <status> · <pnlPct>%". */
export function formatExitTooltip(price: number, status: string, pnlPct: number): string {
  return `Exited ${formatPrice(price)} · ${status} · ${formatSignedPct(pnlPct)}`;
}

/** Exit colour: green in profit (pnlPct ≥ 0), red at a loss. */
export function exitColor(pnlPct: number): string {
  return pnlPct >= 0 ? EXIT_PROFIT_COLOR : EXIT_LOSS_COLOR;
}

/**
 * Fan a position list out into positioned-marker descriptors: for each position,
 * an ENTRY marker (▲, when an entry is present), a PARTIAL marker (◐, intraday
 * when a partial book is present) and an EXIT marker (●, when an exit is present).
 * An open position (exit null) yields just the entry; a not-yet-entered breakout
 * (entry null) is skipped. Order is stable (entry → partial → exit, per position)
 * so React keys stay consistent across re-renders.
 */
export function buildTradeMarkers(positions: PositionMarker[]): TradeMarkerDescriptor[] {
  const out: TradeMarkerDescriptor[] = [];
  for (const p of positions) {
    if (p.entry) {
      out.push({
        key: `${p.id}:entry`,
        positionId: p.id,
        kind: 'entry',
        glyph: '▲',
        color: ENTRY_COLOR,
        timeMs: p.entry.time,
        price: p.entry.price,
        tooltip: formatEntryTooltip(p.entry.price, p.provenance),
        detail: formatEntryDetail(p.targetPct, p.stopPct),
      });
    }
    if (p.partial) {
      out.push({
        key: `${p.id}:partial`,
        positionId: p.id,
        kind: 'partial',
        glyph: '◐',
        color: PARTIAL_COLOR,
        timeMs: p.partial.time,
        price: p.partial.price,
        tooltip: formatPartialTooltip(p.partial.fraction, p.partial.price),
      });
    }
    if (p.exit) {
      out.push({
        key: `${p.id}:exit`,
        positionId: p.id,
        kind: 'exit',
        glyph: '●',
        color: exitColor(p.exit.pnlPct),
        timeMs: p.exit.time,
        price: p.exit.price,
        tooltip: formatExitTooltip(p.exit.price, p.exit.status, p.exit.pnlPct),
        detail: p.exit.reason ?? undefined,
      });
    }
  }
  return out;
}
