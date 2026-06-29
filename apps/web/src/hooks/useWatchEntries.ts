import { useEffect, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import { watchApi } from '../services/watch.service';
import type { WatchEntry, WatchStatus } from '../types/watch.types';

const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4001');

export function useWatchEntries(status?: WatchStatus, date?: string) {
  const [entries, setEntries] = useState<WatchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await watchApi.list(status, date);
      setEntries(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status, date]);

  useEffect(() => { refetch(); }, [refetch]);

  useEffect(() => {
    const socket: Socket = io(`${API_BASE}/watch`, { transports: ['websocket'] });
    // The full updated row arrives on every tick — merge in place so React
    // only re-renders the one row that changed instead of the whole table.
    // Eliminates the per-tick "page flash" that hard-refresh papered over.
    const onEntry = (incoming: WatchEntry) => {
      setEntries((prev) => {
        const idx = prev.findIndex((e) => e.id === incoming.id);
        if (idx < 0) return prev; // not in current view (different status filter, etc.)
        const next = prev.slice();
        next[idx] = { ...next[idx], ...incoming };
        return next;
      });
    };
    // Status transitions and new-row events are rare — refetch is fine for
    // these. (The tick path above handles the high-frequency case.)
    const onEvent = () => { refetch(); };
    const onCreated = () => { refetch(); };
    socket.on('watch:entry', onEntry);
    socket.on('watch:event', onEvent);
    socket.on('watch:created', onCreated);
    return () => {
      socket.off('watch:entry', onEntry);
      socket.off('watch:event', onEvent);
      socket.off('watch:created', onCreated);
      socket.disconnect();
    };
  }, [refetch]);

  return { entries, loading, error, refetch };
}
