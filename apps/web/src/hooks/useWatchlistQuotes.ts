import { useCallback, useEffect } from 'react';
import api from '@/services/api';
import { wsService } from '@/services/websocket';
import { quoteForItem } from '@/services/browser-feed';
import { useMarketStore } from '@/stores/market-store';
import type { Quote } from '@/types';
import type { WatchlistItem } from '@/stores/watchlist-store';
import { useLivePollMs } from './useLivePollMs';

interface QuoteRow {
  token: string;
  exchange: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
}

/** Fallback cadence: used only while the feed is not hub-served and Live. */
const POLL_MS = 5_000;

/**
 * Keep the watchlist rows current. The rows stream over /ws as `watchlist`
 * (hub priority 3) and each matching tick updates the shared quote store under
 * the row's own symbol. One batched POST /market-data/quotes on change, and as
 * the fallback poll — off while the hub feeds this browser and the feed is Live
 * (SP1 M4).
 */
export function useWatchlistQuotes(items: WatchlistItem[]): void {
  const updateQuote = useMarketStore((s) => s.updateQuote);
  const pollMs = useLivePollMs(POLL_MS);

  const fetchOnce = useCallback(
    async (isCancelled: () => boolean) => {
      try {
        const res = await api.post('/market-data/quotes', {
          items: items.map((i) => ({ token: i.token, exchange: i.exchange })),
        });
        const list: QuoteRow[] = res.data?.quotes ?? [];
        if (isCancelled()) return;
        const byKey = new Map(list.map((q) => [`${q.exchange.toUpperCase()}:${q.token}`, q]));
        for (const it of items) {
          const q = byKey.get(`${it.exchange.toUpperCase()}:${it.token}`);
          if (!q || q.ltp == null) continue;
          updateQuote({
            symbol: it.symbol,
            token: it.token,
            exchange: it.exchange,
            ltp: q.ltp,
            open: q.open,
            high: q.high,
            low: q.low,
            close: q.close,
            change: q.change,
            changePercent: q.changePercent,
            volume: q.volume,
            timestamp: new Date(),
          } as Quote);
        }
      } catch {
        // Silent — rows keep their last value until a poll succeeds.
      }
    },
    [items, updateQuote],
  );

  // Live rows + one snapshot whenever the list changes.
  useEffect(() => {
    if (items.length === 0) return;
    let cancelled = false;
    const refs = items.map((i) => ({ token: i.token, exchange: i.exchange, symbol: i.symbol }));
    wsService.emitSubscribe(refs, 'watchlist');
    const unsubTick = wsService.subscribe('tick', (data) => {
      for (const it of items) {
        const q = quoteForItem(it, data as Parameters<typeof quoteForItem>[1]);
        if (q) updateQuote(q);
      }
    });
    void fetchOnce(() => cancelled);
    return () => {
      cancelled = true;
      unsubTick();
      wsService.emitUnsubscribe(refs);
    };
  }, [items, updateQuote, fetchOnce]);

  // Fallback poll: off while the feed is hub-served and Live.
  useEffect(() => {
    if (items.length === 0 || pollMs === false) return;
    let cancelled = false;
    const id = setInterval(() => void fetchOnce(() => cancelled), pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [items, fetchOnce, pollMs]);
}
