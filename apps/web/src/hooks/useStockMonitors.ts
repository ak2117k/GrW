import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/services/api';

/**
 * A single stock monitor as returned by `GET /api/monitor`.
 *
 * This is the EXACT backend contract (`StockMonitorDto`, spec §4.5): one
 * persisted per-user watcher for an instrument, targeting a profit % measured
 * from the reference price captured at add-time. Nullable fields are `null`
 * (never `undefined`) — they stay unset until the backend sweep prices the
 * token / fires the target. All timestamps are ISO strings.
 */
export interface StockMonitor {
  id: string;
  symbol: string;
  exchange: string;
  token: string;
  referencePrice: number | null;
  targetPercent: number;
  targetPrice: number | null;
  status: 'WATCHING' | 'TARGET_HIT';
  lastLtp: number | null;
  currentPercent: number | null;
  triggeredAt: string | null; // ISO | null
  createdAt: string; // ISO
}

interface MonitorsResponse {
  monitors: StockMonitor[];
}

/** Payload for adding a monitor — POST `/api/monitor`. */
export interface AddMonitorInput {
  symbol: string;
  exchange: string;
  token: string;
  targetPercent: number;
}

export interface UseStockMonitors {
  data: StockMonitor[] | null;
  loading: boolean;
  /** A human-facing error message for load failures, else null. */
  error: string | null;
  refresh: () => Promise<void>;
  add: (input: AddMonitorInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** How often to re-poll `GET /monitor` while mounted. */
const POLL_INTERVAL_MS = 10_000;

/**
 * Loads the caller's stock monitors (newest first). Fetches on mount and then
 * polls every ~10s (detection happens server-side, so polling is sufficient —
 * no per-tick WS needed on the page). `add` POSTs then refreshes; `remove`
 * DELETEs then refreshes. The polling interval is cleared on unmount.
 */
export function useStockMonitors(): UseStockMonitors {
  const [data, setData] = useState<StockMonitor[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: res } = await api.get<MonitorsResponse>('/monitor');
      setData(res.monitors ?? []);
    } catch {
      setError('Could not load your monitors. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  const add = useCallback(
    async (input: AddMonitorInput) => {
      await api.post('/monitor', input);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await api.delete(`/monitor/${id}`);
      await refresh();
    },
    [refresh],
  );

  // Fetch on mount, then poll on an interval. Keep the callback in a ref so the
  // interval always calls the latest `refresh` without being torn down/rebuilt.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refreshRef.current();
    const id = setInterval(() => {
      void refreshRef.current();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return { data, loading, error, refresh, add, remove };
}
