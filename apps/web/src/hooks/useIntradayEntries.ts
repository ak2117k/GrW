import { useCallback, useEffect, useState } from 'react';
import { listIntradayEntries, getIntradayPnl, type AnandEntry, type PnlSummary } from '../services/anand';

const REFRESH_MS = 30_000;

export function useIntradayEntries(status?: string, date?: string, enabled = true) {
  const [entries, setEntries] = useState<AnandEntry[]>([]);
  const [pnl, setPnl] = useState<PnlSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Don't fetch the plan-gated data until the caller confirms access — an
    // unsubscribed USER would otherwise trigger a 403 that flashes as an error.
    if (!enabled) return;
    try {
      const [rows, summary] = await Promise.all([
        listIntradayEntries({
          status: status || undefined,
          from: date ? `${date}T00:00:00.000Z` : undefined,
          to: date ? `${date}T23:59:59.999Z` : undefined,
        }),
        getIntradayPnl(),
      ]);
      setEntries(rows);
      setPnl(summary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [status, date, enabled]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh, enabled]);

  return { entries, pnl, loading, error, refresh };
}
