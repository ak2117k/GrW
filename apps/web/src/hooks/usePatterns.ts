import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';

/**
 * A single detected pattern, exactly as returned by
 * `GET /api/signals/patterns`.
 *
 * `time`, the `points[]` entries and `confirmTime` are all REAL epoch
 * MILLISECONDS of the anchor / peak candles — they must be converted to
 * seconds and mapped onto the chart's gap-compressed time axis before use
 * (see `mapPatternsToChartTime`).
 */
export interface PatternMarker {
  category: 'CANDLESTICK' | 'CHART';
  name: string; // 'BULLISH_ENGULFING' | 'HAMMER' | 'DOJI' | 'DOUBLE_TOP' | ...
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  time: number; // epoch MS of the anchor candle
  points: number[]; // CHART: [firstPeakMs, secondPeakMs]; CANDLESTICK: []
  necklinePrice: number | null;
  confirmed: boolean | null;
  confirmTime: number | null; // epoch MS
}

export interface PatternsResponse {
  symbol: string;
  timeframe: string;
  count: number;
  patterns: PatternMarker[];
}

interface UsePatternsReturn {
  patterns: PatternMarker[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

const POLL_INTERVAL_MS = 60_000;

/**
 * Polls `/api/signals/patterns?token=X&exchange=Y&timeframe=Z` every 60s while
 * `enabled && token`. Returns the latest PatternMarker[] with loading + error.
 *
 * Mirrors `useZones`: a memoised fetch helper, an effect driving the initial +
 * interval calls, and an AbortController so a symbol/timeframe switch mid-flight
 * doesn't write stale data into the next render. On any network error we surface
 * the Error but keep `patterns` as an empty array so the overlay is never handed
 * `undefined` and never crashes.
 */
export function usePatterns(
  token: string | null,
  timeframe: string | null,
  exchange: string | null,
  enabled: boolean,
): UsePatternsReturn {
  const [patterns, setPatterns] = useState<PatternMarker[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchPatterns = useCallback(async () => {
    // Only fetch when explicitly enabled and we have a token.
    if (!enabled || !token) {
      setPatterns([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Cancel any in-flight request before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const response = await api.get('/signals/patterns', {
        params: {
          token,
          exchange: exchange ?? 'NSE',
          timeframe: timeframe ?? '15m',
        },
        signal: controller.signal,
      });
      // Defensive unwrap — backend may wrap or return a bare array.
      const payload = response.data;
      const candidate =
        (payload?.patterns as PatternMarker[] | undefined) ??
        (payload?.data as PatternMarker[] | undefined) ??
        payload;
      const next: PatternMarker[] = Array.isArray(candidate) ? candidate : [];
      setPatterns(next);
      setError(null);
    } catch (err) {
      // Aborted requests are expected on rapid input changes — don't surface
      // them as errors and don't clobber existing state.
      const isAbort =
        (err as { name?: string })?.name === 'CanceledError' ||
        (err as { name?: string })?.name === 'AbortError' ||
        (err as { code?: string })?.code === 'ERR_CANCELED';
      if (isAbort) return;
      const e = err instanceof Error ? err : new Error('Failed to fetch patterns');
      setError(e);
      // Never throw to the caller — the overlay must always get an array.
      setPatterns([]);
    } finally {
      // Only clear loading if this controller is still the active one.
      if (abortRef.current === controller) {
        setLoading(false);
      }
    }
  }, [token, exchange, timeframe, enabled]);

  useEffect(() => {
    // Clear immediately when disabled or missing a token so a stale overlay
    // doesn't linger while the next fetch runs.
    if (!enabled || !token) {
      setPatterns([]);
      setError(null);
      setLoading(false);
      return;
    }

    fetchPatterns();
    const intervalId = window.setInterval(fetchPatterns, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchPatterns, enabled, token, exchange, timeframe]);

  return { patterns, loading, error, refetch: fetchPatterns };
}
