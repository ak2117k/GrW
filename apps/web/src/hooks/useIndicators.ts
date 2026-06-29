import { useEffect, useState } from 'react';
import api from '@/services/api';
import type { IndicatorReadings } from '@/components/stock-overview/SetupContextCard';

interface UseIndicatorsResult {
  indicators: IndicatorReadings | null;
  loading: boolean;
}

/**
 * Standalone indicator readings (EMA9/EMA21, RSI14, MACD histogram, BB
 * position, ROC10) for the IndicatorsCard. Hits GET /signals/indicators.
 *
 * Returns `indicators: null` when the backend reports fewer than 30
 * candles for the (token, timeframe) — caller renders an "unavailable"
 * caption in that case. Refetches when token, exchange, or timeframe
 * changes.
 */
export function useIndicators(
  token: string,
  exchange: string,
  timeframe: string,
): UseIndicatorsResult {
  const [indicators, setIndicators] = useState<IndicatorReadings | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token || token === '0' || !exchange || !timeframe) {
      setIndicators(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Reset between symbol/timeframe switches so the previous values don't
    // hang around while the new fetch is in flight.
    setIndicators(null);
    setLoading(true);

    api
      .get<{ indicators: IndicatorReadings | null }>('/signals/indicators', {
        params: { token, exchange, timeframe },
      })
      .then((r) => {
        if (cancelled) return;
        setIndicators(r.data?.indicators ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setIndicators(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, exchange, timeframe]);

  return { indicators, loading };
}
