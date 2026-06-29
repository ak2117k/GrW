import { useEffect, useState } from 'react';
import { getSwingDailyOhlc, type SwingDailyOhlcResponse } from '../services/anand';

/**
 * Lazy day-wise OHLC for a single swing trade. Only fetches once `enabled`
 * becomes true (i.e. the row is expanded). Closed/historical data, so there is
 * no polling — one fetch per enable is enough. Re-expanding a row re-fetches.
 */
export function useSwingDailyOhlc(id: string, enabled: boolean) {
  const [data, setData] = useState<SwingDailyOhlcResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSwingDailyOhlc(id)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'fetch failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, enabled]);

  return { data, loading, error };
}
