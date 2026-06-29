import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/services/api';

export interface InstrumentResult {
  symbol: string;
  token: string;
  name: string;
  exchange: string;
  segment: string;
  lotSize: number;
  tickSize: number;
}

interface UseInstrumentSearchReturn {
  results: InstrumentResult[];
  isLoading: boolean;
  error: string | null;
  search: (query: string) => void;
  clear: () => void;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/**
 * Hook that searches instruments via the backend API with debouncing.
 * The backend searches the local DB first, then falls back to Angel One
 * searchScrip for broader results.
 */
export function useInstrumentSearch(): UseInstrumentSearchReturn {
  const [results, setResults] = useState<InstrumentResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clear = useCallback(() => {
    setResults([]);
    setError(null);
    setIsLoading(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const search = useCallback((query: string) => {
    // Clear previous timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Cancel in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const trimmed = query.trim();

    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await api.get('/market-data/instruments', {
          params: { search: trimmed },
          signal: controller.signal,
        });

        if (!controller.signal.aborted) {
          const instruments: InstrumentResult[] = (res.data?.instruments ?? []).map(
            (inst: Record<string, unknown>) => ({
              symbol: String(inst.symbol ?? ''),
              token: String(inst.token ?? ''),
              name: String(inst.name ?? ''),
              exchange: String(inst.exchange ?? ''),
              segment: String(inst.segment ?? ''),
              lotSize: Number(inst.lotSize ?? 1),
              tickSize: Number(inst.tickSize ?? 0.05),
            }),
          );
          setResults(instruments);
          setIsLoading(false);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'CanceledError') return;
        if (!controller.signal.aborted) {
          setError('Search failed. Please try again.');
          setIsLoading(false);
        }
      }
    }, DEBOUNCE_MS);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { results, isLoading, error, search, clear };
}
