import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { listUngatedEntries } from '../services/ungatedWatch';
import type { UngatedWatchEntry } from '../types/ungatedWatch.types';
import type { WatchStatus } from '../types/watch.types';

const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4001');

export function useUngatedWatchEntries(filter?: WatchStatus, date?: string) {
  const [entries, setEntries] = useState<UngatedWatchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    listUngatedEntries({ status: filter, date })
      .then((data) => { setEntries(data); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [filter, date]);

  // Live in-place merges on the ungated namespace. Rows not currently in
  // view (different status filter, etc.) are ignored — no surprise rows
  // appearing when the user has filtered to e.g. TARGET_HIT only.
  useEffect(() => {
    const socket: Socket = io(`${API_BASE}/ungated-watch`, { transports: ['websocket'] });
    const onEntry = (incoming: UngatedWatchEntry) => {
      setEntries((prev) => {
        const idx = prev.findIndex((e) => e.id === incoming.id);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], ...incoming };
        return next;
      });
    };
    socket.on('ungated:entry', onEntry);
    return () => {
      socket.off('ungated:entry', onEntry);
      socket.disconnect();
    };
  }, []);

  return { entries, loading, error };
}
