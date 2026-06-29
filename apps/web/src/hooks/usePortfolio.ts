import { useEffect, useRef } from 'react';
import { usePortfolioStore } from '@/stores/portfolio-store';

const REFRESH_INTERVAL = 30_000; // 30 seconds

export function usePortfolio() {
  const fetchAll = usePortfolioStore((s) => s.fetchAll);
  const summary = usePortfolioStore((s) => s.summary);
  const equityCurve = usePortfolioStore((s) => s.equityCurve);
  const dailyPnl = usePortfolioStore((s) => s.dailyPnl);
  const segmentBreakdown = usePortfolioStore((s) => s.segmentBreakdown);
  const recentTrades = usePortfolioStore((s) => s.recentTrades);
  const isLoading = usePortfolioStore((s) => s.isLoading);
  const error = usePortfolioStore((s) => s.error);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchAll();

    intervalRef.current = setInterval(fetchAll, REFRESH_INTERVAL);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchAll]);

  return {
    summary,
    equityCurve,
    dailyPnl,
    segmentBreakdown,
    recentTrades,
    isLoading,
    error,
  };
}
