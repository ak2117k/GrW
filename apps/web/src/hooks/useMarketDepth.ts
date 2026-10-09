import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/services/api';
import { wsService } from '@/services/websocket';
import { depthFromTick, tickMatches } from '@/services/browser-feed';
import type { MarketDepth } from '@td/shared';
import { useLivePollMs } from './useLivePollMs';

interface UseMarketDepthResult {
  depth: MarketDepth | null;
  loading: boolean;
}

/** Fallback cadence: used only while the feed is not hub-served and Live. */
const DEPTH_POLL_MS = 2_000;

/**
 * Five-level depth for one instrument. One fetch of
 * /market-data/instruments/:token/depth on open, then the book carried on each
 * live tick (SNAP_QUOTE best-five). The 2 s poll runs only as the fallback: off
 * while the hub feeds this browser and the feed is Live (SP1 M4). The backend
 * keeps its own 1.5s in-memory depth cache, so even the fallback poll costs at
 * most one SmartAPI call per ~1.5s per (exchange, token), however many tabs.
 *
 * Returns `depth: null` when the endpoint reports no depth available
 * (market closed, token not subscribable, etc.) — caller renders a
 * "Depth unavailable" caption in that case.
 */
export function useMarketDepth(token: string, exchange: string): UseMarketDepthResult {
  const [depth, setDepth] = useState<MarketDepth | null>(null);
  const [loading, setLoading] = useState(false);
  const cancelRef = useRef(false);
  const pollMs = useLivePollMs(DEPTH_POLL_MS);
  const valid = Boolean(token && token !== '0' && exchange);

  const fetchDepth = useCallback(async () => {
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
  }, [token, exchange]);

  useEffect(() => {
    if (!valid) {
      setDepth(null);
      setLoading(false);
      return;
    }
    cancelRef.current = false;
    // Reset between symbol switches so we don't show the previous instrument's
    // ladder while the first fetch for the new one is in flight.
    setDepth(null);
    setLoading(true);
    void fetchDepth();

    const ref = { token, exchange };
    wsService.emitSubscribe([ref], 'chart');
    const unsubTick = wsService.subscribe('tick', (data) => {
      if (cancelRef.current || !tickMatches(data, token, exchange)) return;
      const next = depthFromTick(data);
      if (!next) return; // a tick without a book keeps the last ladder
      setDepth(next);
      setLoading(false);
    });

    return () => {
      cancelRef.current = true;
      unsubTick();
      wsService.emitUnsubscribe([ref]);
    };
  }, [valid, token, exchange, fetchDepth]);

  // Fallback poll: off while the feed is hub-served and Live.
  useEffect(() => {
    if (!valid || pollMs === false) return;
    const id = setInterval(() => void fetchDepth(), pollMs);
    return () => clearInterval(id);
  }, [valid, fetchDepth, pollMs]);

  return { depth, loading };
}
