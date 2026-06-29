import { useCallback, useEffect, useState } from 'react';
import { getSwingCapital, type SwingCapital } from '../services/anand';

const REFRESH_MS = 30_000;

/**
 * Swing capital summary: base allocation, capital currently engaged in open
 * positions, realized P&L, and what's available to deploy. Polled so engaged
 * capital visibly recycles back to `available` as positions exit.
 */
export function useSwingCapital() {
  const [capital, setCapital] = useState<SwingCapital | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getSwingCapital();
      setCapital(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  return { capital, loading, error, refresh };
}
