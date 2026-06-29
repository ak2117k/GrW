import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { listAdaptiveStopEntries } from '../services/adaptiveStopWatch';
import type { AdaptiveStopWatchEntry } from '../types/adaptiveStopWatch.types';
import type { WatchStatus } from '../types/watch.types';

const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4001');

export function useAdaptiveStopWatchEntries(filter?: WatchStatus, date?: string) {
  const [entries, setEntries] = useState<AdaptiveStopWatchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    listAdaptiveStopEntries({ status: filter, date })
      .then((data) => { setEntries(data); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [filter, date]);

  // Live in-place merges on the adaptive-stop namespace. Rows not currently in
  // view (different status filter, etc.) are ignored — no surprise rows
  // appearing when the user has filtered to e.g. TARGET_HIT only.
  useEffect(() => {
    const socket: Socket = io(`${API_BASE}/adaptive-stop-watch`, { transports: ['websocket'] });
    const onEntry = (incoming: AdaptiveStopWatchEntry) => {
      setEntries((prev) => {
        const idx = prev.findIndex((e) => e.id === incoming.id);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], ...incoming };
        return next;
      });
    };
    socket.on('adaptive-stop:entry', onEntry);
    return () => {
      socket.off('adaptive-stop:entry', onEntry);
      socket.disconnect();
    };
  }, []);

  return { entries, loading, error };
}
