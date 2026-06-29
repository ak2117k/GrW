import { useEffect, useState, useCallback, useRef } from 'react';
import { AIInsight, getLatestInsight, requestInsight } from '@/services/insights';

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_ATTEMPTS = 60; // ~3 minutes

interface UseInsightResult {
  insight: AIInsight | null;
  isLoading: boolean;
  isWaiting: boolean; // pending or in_progress
  error: string | null;
  ask: () => Promise<void>;
}

export function useInsight(
  sectionKey: string,
  contextKey: string,
  contextData: Record<string, unknown>,
): UseInsightResult {
  const [insight, setInsight] = useState<AIInsight | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollAttempts = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isWaiting =
    insight !== null && (insight.status === 'pending' || insight.status === 'in_progress');

  const fetchLatest = useCallback(async () => {
    try {
      const row = await getLatestInsight(sectionKey, contextKey);
      setInsight(row);
      setError(null);
      return row;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch insight');
      return null;
    }
  }, [sectionKey, contextKey]);

  // Initial load
  useEffect(() => {
    setIsLoading(true);
    fetchLatest().finally(() => setIsLoading(false));
  }, [fetchLatest]);

  // Polling while waiting
  useEffect(() => {
    if (!isWaiting) {
      pollAttempts.current = 0;
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }

    const tick = async () => {
      pollAttempts.current += 1;
      if (pollAttempts.current > MAX_POLL_ATTEMPTS) {
        setError('Taking longer than expected. Please retry.');
        return;
      }
      const row = await fetchLatest();
      if (row && (row.status === 'pending' || row.status === 'in_progress')) {
        pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [isWaiting, fetchLatest]);

  const ask = useCallback(async () => {
    setError(null);
    pollAttempts.current = 0;
    try {
      const row = await requestInsight(sectionKey, contextKey, contextData);
      setInsight(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request insight');
    }
  }, [sectionKey, contextKey, contextData]);

  return { insight, isLoading, isWaiting, error, ask };
}
