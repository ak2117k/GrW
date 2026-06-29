import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import type { StrongZone } from '@/types';

interface UseZonesReturn {
  zones: StrongZone[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const POLL_INTERVAL_MS = 60_000;

/**
 * Polls `/api/signals/zones?token=X&exchange=Y` every 60s while both inputs
 * are truthy. Returns the latest StrongZone[] alongside loading + error state.
 *
 * Polling stops when:
 *  - the component unmounts,
 *  - either token or exchange becomes null/empty,
 *  - the inputs change (the effect tears down the timer + aborts in-flight).
 *
 * On any network error we surface the Error but keep `zones` as an empty
 * array so the chart overlay is never handed `undefined` and never crashes.
 *
 * Pattern mirrors `useChartData.ts` — fetch helper memoised via useCallback,
 * an effect to drive initial + interval calls, an AbortController so a
 * symbol switch mid-flight doesn't write stale data into the next render.
 */
export function useZones(
  token: string | null,
  exchange: string | null,
  timeframe: string | null,
): UseZonesReturn {
  const [zones, setZones] = useState<StrongZone[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchZones = useCallback(async () => {
    // Bail early when we don't have both inputs — nothing to fetch.
    if (!token || !exchange) {
      setZones([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    // Cancel any in-flight request before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    try {
      const response = await api.get('/signals/zones', {
        params: { token, exchange, interval: timeframe ?? '15m' },
        signal: controller.signal,
      });
      // Defensive unwrap — backend may wrap or return bare array.
      const payload = response.data;
      const candidate =
        (payload?.zones as StrongZone[] | undefined) ??
        (payload?.data as StrongZone[] | undefined) ??
        payload;
      const next: StrongZone[] = Array.isArray(candidate) ? candidate : [];
      setZones(next);
      setError(null);
    } catch (err) {
      // Aborted requests are expected on rapid input changes — don't
      // surface them as errors and don't clobber existing state.
      const isAbort =
        (err as { name?: string })?.name === 'CanceledError' ||
        (err as { name?: string })?.name === 'AbortError' ||
        (err as { code?: string })?.code === 'ERR_CANCELED';
      if (isAbort) return;
      const e = err instanceof Error ? err : new Error('Failed to fetch zones');
      setError(e);
      // Spec requires empty array on error — never throw to the caller.
      setZones([]);
    } finally {
      // Only clear loading if this controller is still the active one
      // (otherwise a newer fetch is already running).
      if (abortRef.current === controller) {
        setIsLoading(false);
      }
    }
  }, [token, exchange, timeframe]);

  useEffect(() => {
    // Reset zones immediately when inputs change so a stale chart overlay
    // doesn't show the previous symbol's zones during the next fetch.
    if (!token || !exchange) {
      setZones([]);
      setError(null);
      setIsLoading(false);
      return;
    }

    fetchZones();
    const intervalId = window.setInterval(fetchZones, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchZones, token, exchange, timeframe]);

  return { zones, isLoading, error, refetch: fetchZones };
}
