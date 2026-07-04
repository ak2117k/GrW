import { useEffect, useState } from 'react';
import api from '@/services/api';

export interface DashboardSummary {
  totalPnl: number;
  /** Fraction in [0,1] — the page renders it as `winRate * 100`%. */
  winRate: number;
  totalTrades: number;
}
export interface SegmentPnl {
  segment: string;
  pnl: number;
  trades: number;
}
export interface BrokerStatus {
  connected: boolean;
  clientIdMasked?: string | null;
  lastValidated?: string | null;
}

// --- Real backend shapes (verified against portfolio.service.ts) ---
// GET /api/portfolio/summary → PortfolioSummary. It carries totalPnl,
// totalTrades and MANY more fields (todayPnl/weekPnl/monthPnl/openPositions/
// maxDrawdown/sharpeRatio). Crucially `winRate` there is a PERCENTAGE (0-100,
// e.g. 62.5), not a fraction — so we divide by 100 at the fetch site to match
// the fraction contract the page (and pickHeroStats' test) expect.
interface RawSummary {
  totalPnl: number;
  winRate: number; // 0-100 percentage
  totalTrades: number;
}
// GET /api/portfolio/segments → SegmentStats[] = { segment, pnl, trades, wins,
// losses }. The first three already match SegmentPnl; wins/losses are ignored.
interface RawSegment {
  segment: string;
  pnl: number;
  trades: number;
}

/** Null-safe hero stats — a paper/empty account has no summary yet. */
export function pickHeroStats(summary: DashboardSummary | null): { totalPnl: number; winRate: number; trades: number } {
  return { totalPnl: summary?.totalPnl ?? 0, winRate: summary?.winRate ?? 0, trades: summary?.totalTrades ?? 0 };
}

export function useDashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [segments, setSegments] = useState<SegmentPnl[]>([]);
  const [broker, setBroker] = useState<BrokerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const [s, seg, b] = await Promise.allSettled([
        api.get<RawSummary>('/portfolio/summary'),
        api.get<RawSegment[]>('/portfolio/segments'),
        api.get<BrokerStatus>('/broker/status'),
      ]);
      if (!active) return;
      if (s.status === 'fulfilled') {
        const raw = s.value.data;
        setSummary({
          totalPnl: raw.totalPnl ?? 0,
          // backend percentage (0-100) → fraction (0-1)
          winRate: (raw.winRate ?? 0) / 100,
          totalTrades: raw.totalTrades ?? 0,
        });
      }
      if (seg.status === 'fulfilled') {
        setSegments(
          Array.isArray(seg.value.data)
            ? seg.value.data.map((r) => ({ segment: r.segment, pnl: r.pnl ?? 0, trades: r.trades ?? 0 }))
            : [],
        );
      }
      setBroker(b.status === 'fulfilled' ? b.value.data : { connected: false });
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  return { summary, segments, broker, loading };
}
