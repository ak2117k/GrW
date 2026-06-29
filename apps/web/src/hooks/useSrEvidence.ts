import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import type { EvidenceLevel } from '@/types';

interface UseSrEvidenceReturn {
  evidence: EvidenceLevel[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const POLL_INTERVAL_MS = 60_000;

/**
 * Polls `/api/signals/sr-evidence` every 60s. Mirrors useZones — returns an
 * empty array on error, and uses an AbortController to drop stale in-flight
 * responses when the symbol changes.
 */
export function useSrEvidence(
  token: string | null,
  exchange: string | null,
  timeframe: string | null,
): UseSrEvidenceReturn {
  const [evidence, setEvidence] = useState<EvidenceLevel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchEvidence = useCallback(async () => {
    if (!token || !exchange) {
      setEvidence([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    try {
      const response = await api.get('/signals/sr-evidence', {
        params: { token, exchange, interval: timeframe ?? '15m' },
        signal: controller.signal,
      });
      const payload = response.data;
      const candidate =
        (payload?.evidence as EvidenceLevel[] | undefined) ??
        (payload?.data as EvidenceLevel[] | undefined) ??
        payload;
      setEvidence(Array.isArray(candidate) ? candidate : []);
      setError(null);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const code = (err as { code?: string })?.code;
      if (name === 'CanceledError' || name === 'AbortError' || code === 'ERR_CANCELED') return;
      setError(err instanceof Error ? err : new Error('Failed to fetch sr-evidence'));
      setEvidence([]);
    } finally {
      if (abortRef.current === controller) setIsLoading(false);
    }
  }, [token, exchange, timeframe]);

  useEffect(() => {
    if (!token || !exchange) {
      setEvidence([]);
      setError(null);
      setIsLoading(false);
      return;
    }
    fetchEvidence();
    const id = window.setInterval(fetchEvidence, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchEvidence, token, exchange, timeframe]);

  return { evidence, isLoading, error, refetch: fetchEvidence };
}
