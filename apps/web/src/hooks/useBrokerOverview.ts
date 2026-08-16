import { useCallback, useState } from 'react';
import api from '@/services/api';

// GET /api/broker/overview — a live, read-only Angel One account snapshot.
// Each call performs a REAL broker login (rate-limited on the backend), so this
// is driven from a manual Refresh button — it does NOT auto-poll on mount.
export interface Holding {
  symbol: string;
  exchange: string;
  qty: number;
  avgPrice: number;
  ltp: number;
  close: number;
  currentValue: number;
  pnl: number;
  pnlPercent: number;
  dayChangePercent: number;
  /** The instrument's token, for deep-linking to its chart. */
  token: string;
  product: string;
  holdingType: 'NORMAL' | 'MTF' | 'PLEDGED';
}

export interface BrokerOverview {
  funds: { availableCash: number; net: number; utilisedMargin: number };
  profile: { name: string; broker: string; exchanges: string[] };
  positions: Array<{
    symbol: string;
    exchange: string;
    netQty: number;
    ltp: number;
    pnl: number;
    /** The traded instrument's own token — for a derivative, the CONTRACT's. */
    token: string;
    /** The underlying's base symbol (`BDL` for `BDL25AUG261400CE`), or null. */
    underlyingSymbol: string | null;
    /** The underlying's NSE cash token, or null when it could not be resolved. */
    underlyingToken: string | null;
  }>;
  holdings: Holding[];
  holdingSummary: {
    investedValue: number;
    currentValue: number;
    totalPnl: number;
    totalPnlPercent: number;
  };
}

export interface UseBrokerOverview {
  data: BrokerOverview | null;
  loading: boolean;
  /** A human-facing error message for non-404 failures, else null. */
  error: string | null;
  /** True when the backend returned 404 (no Angel One account connected). */
  notConnected: boolean;
  refresh: () => Promise<void>;
}

/**
 * Manual-refresh hook for the broker overview. Nothing is fetched on mount —
 * `refresh()` triggers the single login that backs Balance + Profile +
 * Positions. A 404 is mapped to `notConnected` (a normal, non-error state);
 * any other failure becomes `error`.
 */
export function useBrokerOverview(): UseBrokerOverview {
  const [data, setData] = useState<BrokerOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConnected(false);
    try {
      const { data: overview } = await api.get<BrokerOverview>('/broker/overview');
      setData(overview);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        setData(null);
        setNotConnected(true);
      } else {
        setError('Could not load your Angel One account. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, error, notConnected, refresh };
}
