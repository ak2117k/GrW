import { useCallback, useEffect, useState } from 'react';
import { listSwingEntries, getSwingPnl, type AnandEntry, type PnlSummary } from '../services/anand';

const REFRESH_MS = 30_000;

export function useSwingEntries(status?: string, from?: string) {
  const [entries, setEntries] = useState<AnandEntry[]>([]);
  const [pnl, setPnl] = useState<PnlSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [rows, summary] = await Promise.all([
        listSwingEntries({
          status: status || undefined,
          from: from ? `${from}T00:00:00.000Z` : undefined,
        }),
        getSwingPnl(),
      ]);
      setEntries(rows);
      setPnl(summary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [status, from]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  return { entries, pnl, loading, error, refresh };
}
