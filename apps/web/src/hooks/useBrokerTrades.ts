import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api';

/**
 * A single executed trade from the connected Angel One account, as returned by
 * `GET /api/broker/trades` (the caller's trade book for the day).
 *
 * This is the EXACT backend contract (`BrokerTrade`): one row per fill. `time`
 * is Angel One's raw filltime string (empty string when the broker omits it);
 * `side` is normally 'BUY'/'SELL' but is left open to whatever the broker sends.
 */
export interface BrokerTrade {
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL' | string;
  qty: number;
  price: number;
  time: string; // Angel One filltime string ('' if absent)
  product: string;
  orderId: string;
}

interface TradesResponse {
  trades: BrokerTrade[];
}

export interface UseBrokerTrades {
  data: BrokerTrade[] | null;
  loading: boolean;
  /** A human-facing error message for non-404 failures, else null. */
  error: string | null;
  /** True when the backend returned 404 (no Angel One account connected). */
  notConnected: boolean;
  refresh: () => Promise<void>;
}

/**
 * Loads the caller's executed broker trades for the day. Fetches on mount and
 * exposes `refresh()` for a manual reload. A 404 is mapped to `notConnected`
 * (a normal, non-error state — no broker account linked); any other failure
 * becomes `error`.
 */
export function useBrokerTrades(): UseBrokerTrades {
  const [data, setData] = useState<BrokerTrade[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConnected(false);
    try {
      const { data: res } = await api.get<TradesResponse>('/broker/trades');
      setData(res.trades ?? []);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        setData(null);
        setNotConnected(true);
      } else {
        setError('Could not load your Angel One trades. Please try again.');
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
