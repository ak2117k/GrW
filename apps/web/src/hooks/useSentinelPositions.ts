import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api';

export interface SentinelVerdictView {
  verdict: 'HOLD' | 'EXIT_ARMED' | 'EXIT_NOW' | 'ESCALATE' | string;
  confidence: 'low' | 'medium' | 'high' | string;
  thesisStatus: 'INTACT' | 'WEAKENING' | 'BROKEN' | string;
  reason: string;
  invalidationPoint: string | null;
  evidence: string[];
  netPnl: number;
  greenFloor: number | null;
  triggeredBy: string[];
  at: string;
}

export interface SentinelThesisView {
  direction: string;
  reason: string;
  levelPrice: number | null;
  targetPrice: number | null;
  invalidation: number | null;
  source: string;
}

export interface SentinelPosition {
  trackerId: string;
  symbol: string;
  exchange: string;
  token: string;
  qty: number;
  entryPrice: number;
  lastLtp: number | null;
  entryTime: string;
  verdict: SentinelVerdictView | null;
  thesis: SentinelThesisView | null;
}

/** How often the chart re-reads the agent's view. */
const POLL_MS = 30_000;

/**
 * The sentinel's open positions and its latest read on each.
 *
 * FAILS QUIET, DELIBERATELY. The sentinel is an overlay on a chart that must
 * keep working without it: a 404 (feature not deployed), a 401, or a cold API
 * leaves `positions` empty and the chart draws exactly what it drew before.
 * An error banner over a price chart because an optional overlay could not load
 * would be a worse trade-off than showing no overlay.
 */
export function useSentinelPositions() {
  const [positions, setPositions] = useState<SentinelPosition[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<SentinelPosition[]>('/trade-sentinel/positions');
      setPositions(Array.isArray(data) ? data : []);
    } catch {
      setPositions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { positions, loading, refresh };
}
