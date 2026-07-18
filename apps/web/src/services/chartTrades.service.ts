import api from './api';

/**
 * One realized entry on a position, as returned by
 * `GET /api/portfolio/chart-trades`.
 *
 * `time` is REAL epoch MILLISECONDS — it must be mapped onto the chart's
 * gap-compressed time axis before positioning (see `buildChartTimeResolver`).
 */
export interface PositionEntry {
  time: number; // epoch MS
  price: number;
}

/**
 * A partial book (intraday only): a fraction (0..1) of the position exited
 * ahead of the final exit.
 */
export interface PositionPartial {
  time: number; // epoch MS
  price: number;
  fraction: number; // 0..1
}

/** The final realized exit on a position, present once `exitedAt`+`exitPrice` exist. */
export interface PositionExit {
  time: number; // epoch MS
  price: number;
  status: string; // e.g. "TARGET_HIT" | "STOPPED"
  pnlPct: number; // (exitPrice − entryPrice) / entryPrice * 100 (positions are LONG)
  reason: string | null;
}

/**
 * A single position's chart-annotation shape. Positions come from the paper
 * `swing_entries` / `intraday_entries` / `breakout_swing_entries` tables and are
 * status/percentage-based (no share quantities). `entry` may be null for a
 * not-yet-entered breakout (QUEUED); `partial` is intraday-only.
 */
export interface PositionMarker {
  id: string;
  track: 'SWING' | 'INTRADAY' | 'BREAKOUT';
  provenance: string; // scanner name or track label
  status: string; // TRADED (open) | STOPPED | TARGET_HIT | QUEUED | ...
  targetPct: number;
  stopPct: number;
  entry: PositionEntry | null;
  partial: PositionPartial | null; // intraday only
  exit: PositionExit | null; // null while the position is open
}

interface ChartTradesResponse {
  positions: PositionMarker[];
}

/**
 * Fetch the paper positions for one instrument, shaped for chart annotation.
 *
 * Backend contract: `GET /api/portfolio/chart-trades?token=<token>` →
 * `{ positions: PositionMarker[] }`. The endpoint may 404 until the backend
 * ships — callers should treat a failed/empty fetch as "no positions" rather
 * than error.
 */
export async function getChartTrades(token: string): Promise<PositionMarker[]> {
  const { data } = await api.get<ChartTradesResponse>('/portfolio/chart-trades', {
    params: { token },
  });
  return Array.isArray(data?.positions) ? data.positions : [];
}
