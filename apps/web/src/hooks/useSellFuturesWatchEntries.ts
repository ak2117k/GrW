import { useEffect, useState } from 'react';
import { listSellFuturesEntries } from '../services/sellFuturesWatch';
import type { SellFuturesWatchEntry } from '../types/sellFuturesWatch.types';
import type { WatchStatus } from '../types/watch.types';

// The SELL-futures track is API-only (no WebSocket gateway), so this hook is
// REST-only and polls for freshness instead of merging socket events — unlike
// the ungated hook which subscribes to a live namespace. Keeps the page current
// without opening a socket to a namespace the backend doesn't expose.
const POLL_MS = 20_000;

export function useSellFuturesWatchEntries(filter?: WatchStatus, date?: string) {
  const [entries, setEntries] = useState<SellFuturesWatchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      listSellFuturesEntries({ status: filter, date })
        .then((data) => { if (!cancelled) { setEntries(data); setError(null); } })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (!cancelled && showSpinner) setLoading(false); });
    };
    load(true);
    const id = setInterval(() => load(false), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [filter, date]);

  return { entries, loading, error };
}
