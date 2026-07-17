import api from './api';

/**
 * One realized exit (sell) on a trade, as returned by
 * `GET /api/portfolio/chart-trades`.
 *
 * `time` is REAL epoch MILLISECONDS — it must be mapped onto the chart's
 * gap-compressed time axis before positioning (see `buildChartTimeResolver`).
 */
export interface ChartTradeExit {
  time: number; // epoch MS
  price: number;
  quantitySold: number;
  quantityRemaining: number; // cumulative: entryQty − running sold
  reason: string | null; // e.g. "TARGET_HIT" | "SL_HIT" | "PARTIAL_EXIT"
}

export interface ChartTradeEntry {
  time: number; // epoch MS
  price: number;
  quantity: number;
}

/**
 * A single trade's chart-annotation shape: the entry (may be null if the fill
 * is unknown) plus one marker per realized exit, sorted ascending by time.
 */
export interface ChartTrade {
  tradeId: string;
  side: string; // "BUY" | "SELL" (position direction)
  provenance: string; // "Chartink (...)" | "Manual" | "Signal: RSI" | source
  entry: ChartTradeEntry | null;
  exits: ChartTradeExit[];
}

interface ChartTradesResponse {
  trades: ChartTrade[];
}

/**
 * Fetch the current user's realized trades for one instrument, shaped for
 * chart annotation.
 *
 * Backend contract: `GET /api/portfolio/chart-trades?token=<token>` →
 * `{ trades: ChartTrade[] }`. The endpoint may 404 until the backend ships —
 * callers should treat a failed/empty fetch as "no trades" rather than error.
 */
export async function getChartTrades(token: string): Promise<ChartTrade[]> {
  const { data } = await api.get<ChartTradesResponse>('/portfolio/chart-trades', {
    params: { token },
  });
  return Array.isArray(data?.trades) ? data.trades : [];
}
