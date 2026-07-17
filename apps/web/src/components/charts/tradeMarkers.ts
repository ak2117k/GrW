import type { ChartTrade } from '@/services/chartTrades.service';

/** Colours: entry follows position direction, exits are a neutral blue dot. */
export const ENTRY_BUY_COLOR = '#22c55e';
export const ENTRY_SELL_COLOR = '#ef4444';
export const EXIT_COLOR = '#3b82f6';

export type TradeMarkerKind = 'entry' | 'exit';

/**
 * A flat, chart-agnostic marker descriptor. `timeMs` is still REAL epoch MS —
 * the overlay maps it onto the compressed axis at render time. Pure data, so
 * the entry/exit fan-out, glyphs, colours and tooltip text can be unit-tested
 * without a chart.
 */
export interface TradeMarkerDescriptor {
  key: string;
  tradeId: string;
  kind: TradeMarkerKind;
  glyph: string; // '▲' | '▼' | '●'
  color: string;
  timeMs: number;
  price: number;
  /** Single-line tooltip; exits carry sold/remaining/source, entries the source. */
  tooltip: string;
}

/** Entry glyph by position direction: ▲ for a long (BUY), ▼ for a short (SELL). */
export function entryGlyph(side: string): string {
  return (side ?? '').toUpperCase() === 'SELL' ? '▼' : '▲';
}

/** Entry colour by position direction. */
export function entryColor(side: string): string {
  return (side ?? '').toUpperCase() === 'SELL' ? ENTRY_SELL_COLOR : ENTRY_BUY_COLOR;
}

/**
 * Total entry quantity for the "sold X / total" label. Prefer the entry's
 * declared quantity; when the entry fill is unknown, reconstruct it from the
 * exit itself (`quantitySold + quantityRemaining`, which equals entryQty by the
 * contract's cumulative definition).
 */
export function resolveEntryQty(
  entryQty: number | null,
  quantitySold: number,
  quantityRemaining: number,
): number {
  if (entryQty != null && entryQty > 0) return entryQty;
  return quantitySold + quantityRemaining;
}

/** Tooltip for an exit: "sold X / total · Y remaining · src: <provenance>". */
export function formatExitTooltip(
  quantitySold: number,
  entryQty: number,
  quantityRemaining: number,
  provenance: string,
): string {
  return `sold ${quantitySold} / ${entryQty} · ${quantityRemaining} remaining · src: ${provenance}`;
}

/**
 * Fan a trade list out into positioned-marker descriptors: one entry marker per
 * trade that has an entry, plus one exit marker per realized exit. Trades with
 * neither are skipped. Order is stable (entry then its exits, per trade) so
 * React keys stay consistent across re-renders.
 */
export function buildTradeMarkers(trades: ChartTrade[]): TradeMarkerDescriptor[] {
  const out: TradeMarkerDescriptor[] = [];
  for (const t of trades) {
    if (t.entry) {
      out.push({
        key: `${t.tradeId}:entry`,
        tradeId: t.tradeId,
        kind: 'entry',
        glyph: entryGlyph(t.side),
        color: entryColor(t.side),
        timeMs: t.entry.time,
        price: t.entry.price,
        tooltip: t.provenance,
      });
    }
    t.exits.forEach((exit, i) => {
      const entryQty = resolveEntryQty(
        t.entry?.quantity ?? null,
        exit.quantitySold,
        exit.quantityRemaining,
      );
      out.push({
        key: `${t.tradeId}:exit:${i}`,
        tradeId: t.tradeId,
        kind: 'exit',
        glyph: '●',
        color: EXIT_COLOR,
        timeMs: exit.time,
        price: exit.price,
        tooltip: formatExitTooltip(
          exit.quantitySold,
          entryQty,
          exit.quantityRemaining,
          t.provenance,
        ),
      });
    });
  }
  return out;
}
