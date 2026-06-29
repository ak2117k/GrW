import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4001';

export interface StrategyReviewRange {
  from: string | null;
  to: string | null;
}

/**
 * Headline analysis of ALL watched alerts (win = hit target, loss = stopped
 * out). This is NOT real money — see `realized` for executed-trade P&L.
 */
export interface StrategyReviewSummary {
  watchEntries: number;
  resolved: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  executed: number;
  avgMfePct: number;
  avgMaePct: number;
}

/** Real executed-trade money — kept separate from watched-alert analysis. */
export interface StrategyReviewRealized {
  closedTrades: number;
  winners: number;
  winRate: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  expectancy: number;
}

export interface StrategyReviewScannerRow {
  scanner: string;
  entries: number;
  resolved: number;
  wins: number;
  winRate: number;
  avgMfePct: number;
  avgMaePct: number;
  executed: number;
}

export interface StrategyReviewScoreBucketRow {
  bucket: string;
  entries: number;
  resolved: number;
  wins: number;
  winRate: number;
  avgMfePct: number;
  avgMaePct: number;
}

export interface StrategyReviewFactorRow {
  factor: string;
  passResolved: number;
  passWins: number;
  passWinRate: number;
  failResolved: number;
  failWins: number;
  failWinRate: number;
  edge: number;
}

export interface StrategyReviewDayRow {
  date: string; // "YYYY-MM-DD" IST
  entries: number;
  resolved: number;
  wins: number;
  winRate: number;
  executed: number;
  realizedNetPnl: number;
}

export interface StrategyReview {
  range: StrategyReviewRange;
  summary: StrategyReviewSummary;
  realized: StrategyReviewRealized;
  byScanner: StrategyReviewScannerRow[];
  byScoreBucket: StrategyReviewScoreBucketRow[];
  byFactor: StrategyReviewFactorRow[];
  byDay: StrategyReviewDayRow[];
  sampleWarning: string | null;
}

/**
 * Fetches the strategy-review analytics from the API. Optional `from`/`to`
 * (YYYY-MM-DD) narrow the trading-history window via query params.
 */
export function useStrategyReview(from?: string, to?: string) {
  const [review, setReview] = useState<StrategyReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fetchOnce = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        const qs = params.toString();
        const url = `${API_BASE}/api/strategy-review${qs ? `?${qs}` : ''}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = (await res.json()) as StrategyReview;
        if (alive) setReview(data);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    fetchOnce();
    return () => {
      alive = false;
    };
  }, [from, to]);

  return { review, loading, error };
}
