import { useEffect, useRef } from 'react';
import { useOptionsStore } from '@/stores/options-store';

const REFRESH_INTERVAL_MS = 10_000; // 10 seconds

/**
 * Hook that fetches the options chain on mount and whenever underlying/expiry changes.
 * Auto-refreshes every 10 seconds during market hours (9:15 - 15:30 IST).
 */
export function useOptionsChain() {
  const underlying = useOptionsStore((s) => s.underlying);
  const expiry = useOptionsStore((s) => s.expiry);
  const fetchExpiries = useOptionsStore((s) => s.fetchExpiries);
  const fetchChain = useOptionsStore((s) => s.fetchChain);
  const fetchAnalysis = useOptionsStore((s) => s.fetchAnalysis);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch expiries when underlying changes
  useEffect(() => {
    fetchExpiries();
  }, [underlying, fetchExpiries]);

  // Fetch chain + analysis when expiry changes
  useEffect(() => {
    if (!expiry) return;

    fetchChain();
    fetchAnalysis();

    // Set up auto-refresh
    intervalRef.current = setInterval(() => {
      if (isMarketHours()) {
        fetchChain();
        fetchAnalysis();
      }
    }, REFRESH_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [expiry, fetchChain, fetchAnalysis]);
}

/**
 * Check if current time is within Indian market hours (9:15 - 15:30 IST).
 */
function isMarketHours(): boolean {
  const now = new Date();
  // Convert to IST (UTC+5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(
    now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000,
  );
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const totalMinutes = hours * 60 + minutes;
  const marketOpen = 9 * 60 + 15;
  const marketClose = 15 * 60 + 30;
  return totalMinutes >= marketOpen && totalMinutes <= marketClose;
}
