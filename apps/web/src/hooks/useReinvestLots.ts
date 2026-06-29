import { useCallback, useEffect, useState } from 'react';
import { getReinvestPool, listReinvestLots, type ReinvestLot, type ReinvestPool } from '../services/anand';

const REFRESH_MS = 30_000;

export function useReinvestLots(status?: string) {
  const [lots, setLots] = useState<ReinvestLot[]>([]);
  const [pool, setPool] = useState<ReinvestPool | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [rows, p] = await Promise.all([listReinvestLots(status || undefined), getReinvestPool()]);
      setLots(rows);
      setPool(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  return { lots, pool, loading, error, refresh };
}
