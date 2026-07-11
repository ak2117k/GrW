import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api';

/**
 * A single per-trade tracker as returned by `GET /api/portfolio/trackers`.
 *
 * This is the EXACT backend contract (`TradeTrackerDto`, spec §5): one persisted
 * tracker per real Angel One position/holding, recording entry, exit, the
 * holding-period extreme high/low, the day's high/low and the latest P&L.
 * Nullable fields are `null` (never `undefined`) — they stay unset until the
 * tick updater / close path fills them. All timestamps are ISO strings.
 */
export interface TradeTracker {
  id: string;
  symbol: string;
  exchange: string;
  token: string;
  kind: 'POSITION' | 'HOLDING';
  entryPrice: number;
  qty: number;
  entryTime: string; // ISO
  exitPrice: number | null;
  exitTime: string | null; // ISO | null
  status: 'OPEN' | 'CLOSED';
  holdingHigh: number | null;
  holdingLow: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  lastLtp: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  updatedAt: string; // ISO
}

interface TrackersResponse {
  trackers: TradeTracker[];
}

export interface UseTradeTrackers {
  data: TradeTracker[] | null;
  loading: boolean;
  /** A human-facing error message for non-404 failures, else null. */
  error: string | null;
  /** True when the backend returned 404 (no Angel One account connected). */
  notConnected: boolean;
  refresh: () => Promise<void>;
}

/**
 * Loads the caller's trade trackers (OPEN + CLOSED, newest first). Fetches on
 * mount and exposes `refresh()` for a manual reload. A 404 is mapped to
 * `notConnected` (a normal, non-error state — no broker account linked); any
 * other failure becomes `error`.
 */
export function useTradeTrackers(): UseTradeTrackers {
  const [data, setData] = useState<TradeTracker[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConnected(false);
    try {
      const { data: res } = await api.get<TrackersResponse>('/portfolio/trackers');
      setData(res.trackers ?? []);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        setData(null);
        setNotConnected(true);
      } else {
        setError('Could not load your trade trackers. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, notConnected, refresh };
}
