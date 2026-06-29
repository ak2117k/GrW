import { useCallback, useEffect, useState } from 'react';
import { getBreakoutSwingCapital, type BreakoutSwingCapital } from '../services/breakoutSwing';

const REFRESH_MS = 5_000;

/**
 * Breakout-swing capital summary: base allocation, capital engaged in open
 * positions, realized P&L and what's available. Polled so engaged capital
 * visibly recycles back to `available` as positions exit.
 */
export function useBreakoutSwingCapital() {
  const [capital, setCapital] = useState<BreakoutSwingCapital | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getBreakoutSwingCapital();
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
