import { useCallback, useEffect, useRef } from 'react';
import { wsService } from '@/services/websocket';
import api from '@/services/api';
import { useMarketStore } from '@/stores/market-store';
import { type Quote } from '@/types';
import type { FeedHealth } from '@/services/feed-health';
import { marketPhase } from '@/services/refresh-policy';
import { indexRefs, isFeedSource, quoteForRefs, type FeedRef } from '@/services/browser-feed';
import { useLivePollMs } from './useLivePollMs';

/** Fallback cadence for the index snapshot: used only while the feed is not hub-served and Live. */
const INDICES_POLL_MS = 5_000;

export function useMarketData(): void {
  const updateQuote = useMarketStore((s) => s.updateQuote);
  const setConnected = useMarketStore((s) => s.setConnected);
  const setFeedHealth = useMarketStore((s) => s.setFeedHealth);
  const setFeedSource = useMarketStore((s) => s.setFeedSource);
  const setMarketStatus = useMarketStore((s) => s.setMarketStatus);
  const pollMs = useLivePollMs(INDICES_POLL_MS);
  const mountedRef = useRef(false);
  /** The index tiles, subscribed once as market context (hub priority 2). */
  const indexRefsRef = useRef<FeedRef[] | null>(null);

  // Compute market status on mount and refresh every 30 seconds
  useEffect(() => {
    setMarketStatus(marketPhase());
    const id = setInterval(() => setMarketStatus(marketPhase()), 30_000);
    return () => clearInterval(id);
  }, [setMarketStatus]);

  // The index snapshot. Its first answer also tells us which tiles to stream.
  // REAL data only, never demo numbers.
  const fetchIndices = useCallback(async () => {
    try {
      const res = await api.get('/market-data/indices');
      if (!mountedRef.current) return;
      const indices = res.data?.indices ?? [];
      for (const idx of indices) {
        if (idx.quote && idx.quote.ltp) {
          updateQuote(idx.quote as Quote);
        }
      }
      if (!indexRefsRef.current) {
        const refs = indexRefs(indices);
        if (refs.length > 0) {
          indexRefsRef.current = refs;
          wsService.emitSubscribe(refs, 'context');
        }
      }
    } catch {
      // API unreachable — leave quotes as-is; no demo fallback.
    }
  }, [updateQuote]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchIndices();
    return () => {
      mountedRef.current = false;
      if (indexRefsRef.current) {
        wsService.emitUnsubscribe(indexRefsRef.current);
        indexRefsRef.current = null;
      }
    };
  }, [fetchIndices]);

  // The topology-independent floor when ticks are not arriving (socket down,
  // a legacy feed, or a stall): off while the feed is hub-served and Live.
  useEffect(() => {
    if (pollMs === false) return;
    const id = setInterval(() => void fetchIndices(), pollMs);
    return () => clearInterval(id);
  }, [fetchIndices, pollMs]);

  // WebSocket for live tick updates
  useEffect(() => {
    wsService.connect();
    setFeedSource(wsService.getFeedSource());

    const unsubTick = wsService.subscribe('tick', (data) => {
      // Only the index tiles' own ticks enter the store here, matched by
      // exchange + token and written under the tile's symbol. The owner's room
      // receives EVERY hub price (positions, underlyings, tracks; symbols may
      // be token-named), so a generic "has symbol + change" test would flood
      // the symbol-keyed store. Watchlist rows enter through their own
      // `quoteForItem` path (useWatchlistQuotes); the order ticket and depth
      // card fold ticks locally. A legacy tick carries no change and never
      // entered the store, so nothing that worked before is lost.
      const q = quoteForRefs(indexRefsRef.current ?? [], data);
      if (q) updateQuote(q);
    });

    const unsubConn = wsService.subscribe('connection-status', (data) => {
      const { connected } = data as { connected: boolean };
      setConnected(connected);
    });

    const unsubHealth = wsService.subscribe('feed-health', (data) => {
      const { health } = data as { health: FeedHealth };
      setFeedHealth(health);
    });

    // Which path feeds this browser: 'hub' lets every screen stop polling while Live.
    const unsubSource = wsService.subscribe('feed-source', (data) => {
      const source = (data as { source?: unknown } | null)?.source;
      setFeedSource(isFeedSource(source) ? source : null);
    });

    return () => {
      unsubTick();
      unsubConn();
      unsubHealth();
      unsubSource();
    };
  }, [updateQuote, setConnected, setFeedHealth, setFeedSource]);
}
