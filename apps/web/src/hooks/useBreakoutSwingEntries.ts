import { useCallback, useEffect, useState } from 'react';
import { listBreakoutSwingEntries, type BreakoutSwingEntry } from '../services/breakoutSwing';

const REFRESH_MS = 5_000;

/**
 * Breakout-swing entries (newest first), polled every 5s so resting limit
 * orders, fills and trailing stops update live. `from` is a YYYY-MM-DD IST
 * calendar day; left undefined to fetch the full window.
 */
export function useBreakoutSwingEntries(from?: string) {
  const [entries, setEntries] = useState<BreakoutSwingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listBreakoutSwingEntries({ from: from || undefined });
      setEntries(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [from]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  return { entries, loading, error, refresh };
}
