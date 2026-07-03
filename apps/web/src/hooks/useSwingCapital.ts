import { useCallback, useEffect, useState } from 'react';
import { getSwingCapital, type SwingCapital } from '../services/anand';

const REFRESH_MS = 30_000;

/**
 * Swing capital summary: base allocation, capital currently engaged in open
 * positions, realized P&L, and what's available to deploy. Polled so engaged
 * capital visibly recycles back to `available` as positions exit.
 */
export function useSwingCapital(enabled = true) {
  const [capital, setCapital] = useState<SwingCapital | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Skip the plan-gated fetch until access is confirmed (avoids a 403 flash).
    if (!enabled) return;
    try {
      const data = await getSwingCapital();
      setCapital(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh, enabled]);

  return { capital, loading, error, refresh };
}
