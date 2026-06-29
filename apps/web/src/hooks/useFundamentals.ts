import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/services/api';

/**
 * Fundamentals payload mirrors the API's `FundamentalsResponse` shape.
 * Kept as a local type instead of pulling from `@td/shared` to avoid
 * forcing every package consumer to take a dependency on Yahoo-specific
 * fields — the card is the only consumer.
 */
export interface Fundamentals {
  symbol: string;
  exchange: string;
  fetchedAt: number;

  sector?: string;
  industry?: string;

  marketCap?: number;
  trailingPE?: number;
  priceToBook?: number;
  trailingEPS?: number;
  forwardEPS?: number;

  returnOnEquity?: number;
  debtToEquity?: number;

  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;

  dividendYield?: number;
  beta?: number;

  nextEarningsDate?: string;
  recentEarnings?: Array<{
    quarter: string;
    date: string;
    reportedEPS?: number;
    estimateEPS?: number;
    surprise?: number;
  }>;
}

interface UseFundamentalsResult {
  data: Fundamentals | null;
  loading: boolean;
  error: string | null;
  /** Re-runs the fetch, e.g. from a "Retry" button on a 503. */
  refetch: () => void;
}

/**
 * Fetches /api/fundamentals/:symbol?exchange=<NSE|BSE>.
 *
 * Designed for a single card on the Stock Overview Panel:
 *   - No polling: fundamentals change at most quarterly, server-side cache
 *     is 24h, so one fetch on symbol change is the right cadence.
 *   - 503 from the API → renders the Retry state. We surface the parsed
 *     `error` field rather than the message so the card can match
 *     "fundamentals_unavailable" exactly without parsing strings.
 *   - Stale-data on symbol switch: clears `data` immediately so the card
 *     doesn't flash the previous symbol's numbers under the new ticker.
 */
export function useFundamentals(symbol: string, exchange: string): UseFundamentalsResult {
  const [data, setData] = useState<Fundamentals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to manually trigger a refetch from the Retry button.
  const [retryTick, setRetryTick] = useState(0);
  const cancelRef = useRef(false);

  const refetch = useCallback(() => setRetryTick((n) => n + 1), []);

  useEffect(() => {
    // Skip the fetch entirely for segments where the backend has no
    // fundamentals concept (MCX commodities, NFO derivatives, CDS).
    // The card hides for these too — but if the hook fires anyway, we
    // generate noisy 400/404s in the network tab. Guarding here keeps
    // the request count clean and matches what the card renders.
    const equityExchange = exchange === 'NSE' || exchange === 'BSE';
    // Indices have no fundamentals (no P/E, no market cap — they're
    // composite measures). NIFTY 50 / BANKNIFTY / SENSEX etc. always 404
    // on /fundamentals. Skip the fetch to keep the network tab quiet.
    const isIndex = /^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|SENSEX|INDIAVIX)/i.test(
      symbol.trim(),
    );
    if (!symbol || !exchange || !equityExchange || isIndex) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    cancelRef.current = false;
    setData(null);
    setError(null);
    setLoading(true);

    api
      .get<Fundamentals>(`/fundamentals/${encodeURIComponent(symbol)}`, {
        params: { exchange },
      })
      .then((r) => {
        if (cancelRef.current) return;
        setData(r.data);
        setError(null);
      })
      .catch((err) => {
        if (cancelRef.current) return;
        // Backend returns either:
        //   503 + { error: 'fundamentals_unavailable' } — Yahoo blip / 5xx (retryable)
        //   404 + { error: 'fundamentals_not_listed'  } — ticker has no Yahoo
        //                                                 listing (e.g. F&O,
        //                                                 indices, fresh IPOs)
        // Surface the code so the card can pick a quiet "Not available"
        // vs. an alarming "Server error + Retry" UX.
        const status = err?.response?.status;
        const code =
          err?.response?.data?.error ??
          (status === 404
            ? 'fundamentals_not_listed'
            : status === 503
              ? 'fundamentals_unavailable'
              : 'fetch_failed');
        setError(code);
        setData(null);
      })
      .finally(() => {
        if (!cancelRef.current) setLoading(false);
      });

    return () => {
      cancelRef.current = true;
    };
  }, [symbol, exchange, retryTick]);

  return { data, loading, error, refetch };
}
