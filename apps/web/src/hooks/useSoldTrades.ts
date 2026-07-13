import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api';

/**
 * A single sold trade as returned by `GET /api/portfolio/sold`.
 *
 * This is the EXACT backend contract (`SoldTradeDto`, spec §Backend): one row
 * per CLOSED trade-tracker (a sold position/holding), newest exit first. It
 * carries entry, exit, qty, the holding-period extreme high/low and the final
 * P&L. Nullable fields are `null` (never `undefined`); timestamps are ISO
 * strings.
 */
export interface SoldTrade {
  id: string;
  symbol: string;
  exchange: string;
  token: string;
  kind: 'POSITION' | 'HOLDING';
  entryPrice: number;
  qty: number;
  exitPrice: number | null;
  exitTime: string | null; // ISO | null
  pnl: number | null;
  pnlPercent: number | null;
  holdingHigh: number | null;
  holdingLow: number | null;
}

interface SoldResponse {
  sold: SoldTrade[];
}

export interface UseSoldTrades {
  data: SoldTrade[] | null;
  loading: boolean;
  /** A human-facing error message for non-404 failures, else null. */
  error: string | null;
  /** True when the backend returned 404 (no Angel One account connected). */
  notConnected: boolean;
  refresh: () => Promise<void>;
}

/**
 * Loads the caller's sold trades (CLOSED trackers, newest exit first). Fetches
 * on mount and exposes `refresh()` for a manual reload. A 404 is mapped to
 * `notConnected` (a normal, non-error state — no broker account linked); any
 * other failure becomes `error`.
 */
export function useSoldTrades(): UseSoldTrades {
  const [data, setData] = useState<SoldTrade[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConnected(false);
    try {
      const { data: res } = await api.get<SoldResponse>('/portfolio/sold');
      setData(res.sold ?? []);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        setData(null);
        setNotConnected(true);
      } else {
        setError('Could not load your sold trades. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, notConnected, refresh };
}
