import { useCallback, useMemo } from 'react';
import { useWatchlistStore, type WatchlistItem } from '@/stores/watchlist-store';
import { useMarketStore } from '@/stores/market-store';
import type { Quote } from '@/types';

export interface WatchlistEntry extends WatchlistItem {
  quote: Quote | undefined;
}

export function useWatchlist() {
  const watchlist = useWatchlistStore((s) => s.watchlist);
  const addToWatchlist = useWatchlistStore((s) => s.addToWatchlist);
  const removeFromWatchlist = useWatchlistStore((s) => s.removeFromWatchlist);
  const reorderWatchlist = useWatchlistStore((s) => s.reorderWatchlist);
  const quotes = useMarketStore((s) => s.quotes);

  const entries: WatchlistEntry[] = useMemo(
    () =>
      watchlist.map((item) => ({
        ...item,
        quote: quotes.get(item.symbol),
      })),
    [watchlist, quotes],
  );

  const subscribe = useCallback(() => {
    // Tokens are automatically subscribed via the WebSocket service
    // when the market data hook initializes. This is a placeholder
    // for explicit per-token subscription if the API supports it.
  }, []);

  const unsubscribe = useCallback(() => {
    // Placeholder for explicit unsubscription
  }, []);

  return {
    entries,
    watchlist,
    addToWatchlist,
    removeFromWatchlist,
    reorderWatchlist,
    subscribe,
    unsubscribe,
  };
}
