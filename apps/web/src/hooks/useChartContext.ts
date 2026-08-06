import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import type { EvidenceLevel, StrongZone } from '@/types';
import type { LevelsSnapshot } from '@/components/stock-overview/SetupContextCard';

/** Per-source outcome, as composed server-side. */
export type SourceState = 'ok' | 'empty' | 'failed';

export interface ChartContextSources {
  levels: SourceState;
  zones: SourceState;
  evidence: SourceState;
  trend: SourceState;
}

export interface ChartContextDto {
  interval: string;
  levels: LevelsSnapshot | null;
  zones: StrongZone[];
  evidence: EvidenceLevel[];
  // Slice 2. The endpoint sends `null` until the trend fitter lands.
  trend: null;
  status: 'ready' | 'partial' | 'unavailable';
  sources: ChartContextSources;
}

export interface UseChartContextReturn {
  context: ChartContextDto | null;
  /** True until the FIRST response for the current inputs lands. */
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const POLL_INTERVAL_MS = 60_000;

/** A transport failure is indistinguishable, to the chart, from every source failing. */
const UNAVAILABLE: ChartContextDto = {
  interval: '',
  levels: null,
  zones: [],
  evidence: [],
  trend: null,
  status: 'unavailable',
  sources: { levels: 'failed', zones: 'failed', evidence: 'failed', trend: 'failed' },
};

/**
 * Polls `/api/signals/chart-context` every 60s — the composite that replaces
 * the charts page's three separate polls of /analyze, /zones and /sr-evidence.
 *
 * The point of the composite is that the chart can tell *loading* from *broken*
 * from *genuinely no levels*, which three independent hooks returning `[]` on
 * failure structurally could not. So this hook keeps `context === null` until a
 * response actually lands (that is "loading"), and on a transport failure
 * synthesizes an `unavailable` context rather than an empty one — the chip must
 * never be able to render "none in range" for a request that never succeeded.
 *
 * Pattern mirrors useZones/useSrEvidence: useCallback'd fetch, an effect for
 * initial + interval, and an AbortController so a symbol/timeframe switch
 * mid-flight can't write stale data into the next render.
 */
export function useChartContext(
  token: string | null,
  exchange: string | null,
  interval: string | null,
): UseChartContextReturn {
  const [context, setContext] = useState<ChartContextDto | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchContext = useCallback(async () => {
    if (!token || token === '0' || !exchange) {
      setContext(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    try {
      const response = await api.get<ChartContextDto>('/signals/chart-context', {
        params: { token, exchange, interval: interval ?? '15m' },
        signal: controller.signal,
      });
      const payload = response.data;
      // A malformed body is a failure of the source, not a set of empty
      // sources — collapsing it to `ready` would print "none in range".
      setContext(
        payload && typeof payload === 'object' && payload.status
          ? {
              ...payload,
              zones: Array.isArray(payload.zones) ? payload.zones : [],
              evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
            }
          : { ...UNAVAILABLE, interval: interval ?? '' },
      );
      setError(null);
    } catch (err) {
      // An aborted request is a symbol/timeframe switch, not an outage: the
      // successor fetch owns the state, so leave everything alone.
      const name = (err as { name?: string })?.name;
      const code = (err as { code?: string })?.code;
      if (name === 'CanceledError' || name === 'AbortError' || code === 'ERR_CANCELED') return;
      setError(err instanceof Error ? err : new Error('Failed to fetch chart context'));
      setContext({ ...UNAVAILABLE, interval: interval ?? '' });
    } finally {
      if (abortRef.current === controller) setIsLoading(false);
    }
  }, [token, exchange, interval]);

  useEffect(() => {
    // Drop the previous symbol's context immediately so the chip falls back to
    // "loading" rather than showing the last symbol's levels over new candles.
    setContext(null);
    setError(null);

    if (!token || token === '0' || !exchange) {
      setIsLoading(false);
      return;
    }

    fetchContext();
    const intervalId = window.setInterval(fetchContext, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchContext, token, exchange, interval]);

  return { context, isLoading, error, refetch: fetchContext };
}
