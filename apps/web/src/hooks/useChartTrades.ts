import { useState, useEffect, useCallback, useRef } from 'react';
import { getChartTrades, type ChartTrade } from '@/services/chartTrades.service';

interface UseChartTradesReturn {
  trades: ChartTrade[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Fetches the current user's realized trades for `token`, shaped for chart
 * annotation (`GET /api/portfolio/chart-trades`). Refetches whenever the token
 * changes; unlike the S/R / pattern hooks this does NOT poll — realized trades
 * only change on a fill, and the chart is re-fetched on symbol/timeframe switch
 * anyway (v1 scope: no live streaming).
 *
 * Mirrors `useZones` / `usePatterns`: a memoised fetch helper plus a monotonic
 * request-id guard so a slow earlier fetch (e.g. mid symbol-switch) can't write
 * stale trades into the next render. On any error we surface the Error but keep
 * `trades` as an empty array so the overlay is never handed `undefined`.
 */
export function useChartTrades(token: string | null): UseChartTradesReturn {
  const [trades, setTrades] = useState<ChartTrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const fetchIdRef = useRef(0);

  const fetchTrades = useCallback(async () => {
    if (!token || token === '0') {
      setTrades([]);
      setLoading(false);
      setError(null);
      return;
    }

    const myFetchId = ++fetchIdRef.current;
    setLoading(true);
    try {
      const next = await getChartTrades(token);
      // Stale-response guard: only the latest fetch may apply.
      if (myFetchId !== fetchIdRef.current) return;
      setTrades(next);
      setError(null);
    } catch (err) {
      if (myFetchId !== fetchIdRef.current) return;
      const e = err instanceof Error ? err : new Error('Failed to fetch trades');
      setError(e);
      // Never throw to the caller — the overlay must always get an array.
      setTrades([]);
    } finally {
      if (myFetchId === fetchIdRef.current) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // Clear immediately when the token changes so a stale overlay doesn't
    // linger while the next fetch runs.
    if (!token || token === '0') {
      setTrades([]);
      setError(null);
      setLoading(false);
      return;
    }
    fetchTrades();
  }, [fetchTrades, token]);

  return { trades, loading, error, refetch: fetchTrades };
}
