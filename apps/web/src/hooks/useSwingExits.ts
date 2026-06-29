import { useCallback, useEffect, useState } from 'react';
import { listSwingExits, type AnandEntry } from '../services/anand';

const REFRESH_MS = 30_000;

/**
 * Exited swing positions (status != TRADED), filtered by EXIT date. Distinct
 * from useSwingEntries — that hook filters by ENTRY date, so a multi-day swing
 * entered earlier but cut recently would never appear there. Here `from` is an
 * exit-date floor (exitedAt >= from).
 */
export function useSwingExits(from?: string, status?: string) {
  const [exits, setExits] = useState<AnandEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listSwingExits({
        from: from ? `${from}T00:00:00.000Z` : undefined,
        status: status || undefined,
      });
      setExits(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [from, status]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  return { exits, loading, error, refresh };
}
