import { useCallback, useEffect, useState } from 'react';
import { listSwingEntries, type AnandEntry } from '../services/anand';

const REFRESH_MS = 30_000;

/**
 * The always-on swing Open Book: every currently-open position (status TRADED),
 * with NO date filter. Kept deliberately separate from useSwingEntries — that
 * hook is the date-filtered history log, this one is live exposure. The header's
 * open-positions counter must come from here so it never gets zeroed by the
 * page's `from` date when positions are held overnight.
 */
export function useSwingOpenBook() {
  const [openEntries, setOpenEntries] = useState<AnandEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listSwingEntries({ status: 'TRADED' });
      setOpenEntries(rows);
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

  return { openEntries, loading, error, refresh };
}
