import { useEffect } from 'react';
import api from '@/services/api';
import { useMarketStore } from '@/stores/market-store';
import type { Quote } from '@/types';

/** One row from GET /api/market-data/commodities. */
interface CommodityDto {
  symbol: string;
  token: string;
  exchange: string;
  contractSymbol: string;
  expiry: string;
  ltp: number | null;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
}

const POLL_MS = 10_000;

/**
 * Poll the direct-from-Angel commodities endpoint and feed the results into the
 * shared quote store, so the Commodities tab (StockTable's MCX filter) renders
 * them with no WebSocket feed and no DB row. MCX front-month tokens are resolved
 * server-side, so this stays correct across monthly contract rollovers.
 *
 * Only polls while `enabled` (i.e. the Commodities tab is active) to avoid
 * needless REST calls. The endpoint gives LTP only, so change/OHLC render as 0
 * for now — a live price is the important bit.
 */
export function useCommodities(enabled: boolean): void {
  const updateQuote = useMarketStore((s) => s.updateQuote);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const res = await api.get('/market-data/commodities');
        const list: CommodityDto[] = res.data?.commodities ?? [];
        if (cancelled) return;
        for (const c of list) {
          if (c.ltp == null) continue;
          updateQuote({
            symbol: c.symbol,
            token: c.token,
            exchange: c.exchange,
            ltp: c.ltp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            change: c.change,
            changePercent: c.changePercent,
            volume: c.volume,
            timestamp: new Date(),
          } as Quote);
        }
      } catch {
        // Silent — the tab keeps its placeholder until a poll succeeds.
      }
    };

    void fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, updateQuote]);
}
