import { useEffect, useRef, useState } from 'react';
import api from '@/services/api';
import type { MarketDepth } from '@td/shared';

interface UseMarketDepthResult {
  depth: MarketDepth | null;
  loading: boolean;
}

/**
 * Polls /market-data/instruments/:token/depth every 2s. The backend has its
 * own 1.5s in-memory cache so the actual SmartAPI call rate is at most one
 * per ~1.5s per (exchange, token), regardless of how many open tabs.
 *
 * Returns `depth: null` when the endpoint reports no depth available
 * (market closed, token not subscribable, etc.) — caller renders a
 * "Depth unavailable" caption in that case.
 */
export function useMarketDepth(token: string, exchange: string): UseMarketDepthResult {
  const [depth, setDepth] = useState<MarketDepth | null>(null);
  const [loading, setLoading] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!token || token === '0' || !exchange) {
      setDepth(null);
      setLoading(false);
      return;
    }
    cancelRef.current = false;
    // Reset between symbol switches so we don't show the previous instrument's
    // ladder while the first fetch for the new one is in flight.
    setDepth(null);
    setLoading(true);

    const fetchDepth = async () => {
      try {
        const r = await api.get<{ depth: MarketDepth | null }>(
          `/market-data/instruments/${token}/depth`,
          { params: { exchange } },
        );
        if (!cancelRef.current) setDepth(r.data?.depth ?? null);
      } catch {
        if (!cancelRef.current) setDepth(null);
      } finally {
        if (!cancelRef.current) setLoading(false);
      }
    };

    fetchDepth();
    const id = setInterval(fetchDepth, 2000);
    return () => {
      cancelRef.current = true;
      clearInterval(id);
    };
  }, [token, exchange]);

  return { depth, loading };
}
