import { useEffect, useRef, useState } from 'react';
import api from '@/services/api';
import type { AnalysisDto } from '@/components/stock-overview/SetupContextCard';

interface UseChartAnalysisResult {
  analysis: AnalysisDto | null;
  loading: boolean;
  error: string | null;
}

export function useChartAnalysis(
  token: string,
  exchange: string,
  symbol: string,
  timeframe: string,
): UseChartAnalysisResult {
  const [analysis, setAnalysis] = useState<AnalysisDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialFetchRef = useRef(true);

  useEffect(() => {
    if (!token || token === '0') {
      setAnalysis(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    initialFetchRef.current = true;

    const fetchAnalysis = async () => {
      if (initialFetchRef.current) {
        setLoading(true);
      }
      try {
        const response = await api.get<AnalysisDto>('/signals/analyze', {
          params: { token, exchange, symbol, timeframe },
        });
        if (cancelled) return;
        setAnalysis(response.data);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        const message =
          (err as { response?: { data?: { message?: string } }; message?: string })
            ?.response?.data?.message ||
          (err as { message?: string })?.message ||
          'Failed to fetch analysis';
        setError(message);
      } finally {
        if (!cancelled && initialFetchRef.current) {
          setLoading(false);
          initialFetchRef.current = false;
        }
      }
    };

    fetchAnalysis();
    const interval = setInterval(fetchAnalysis, 60_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [token, exchange, symbol, timeframe]);

  return { analysis, loading, error };
}
