import { useEffect } from 'react';
import api from '@/services/api';
import { useMarketStore } from '@/stores/market-store';
import type { Quote } from '@/types';
import type { WatchlistItem } from '@/stores/watchlist-store';

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

const POLL_MS = 5_000;

/**
 * Poll live quotes for the watchlist's own tokens and feed them into the shared
 * quote store, so watchlist rows (esp. stocks like RELIANCE/TCS that the WS tick
 * feed doesn't deliver) stay current without a page refresh. Batched into one
 * POST /market-data/quotes grouped by exchange server-side. WS ticks still
 * update instantly on top of this when they arrive.
 */
export function useWatchlistQuotes(items: WatchlistItem[]): void {
  const updateQuote = useMarketStore((s) => s.updateQuote);

  useEffect(() => {
    if (items.length === 0) return;
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const res = await api.post('/market-data/quotes', {
          items: items.map((i) => ({ token: i.token, exchange: i.exchange })),
        });
        const list: QuoteRow[] = res.data?.quotes ?? [];
        if (cancelled) return;
        const byToken = new Map(list.map((q) => [q.token, q]));
        for (const it of items) {
          const q = byToken.get(it.token);
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
    };

    void fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [items, updateQuote]);
}
