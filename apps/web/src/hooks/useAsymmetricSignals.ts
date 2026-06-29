import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/services/api';
import toast from 'react-hot-toast';

const REFRESH_INTERVAL_MS = 60_000;

export interface AsymmetricStrikeRec {
  strike: number;
  side: 'CE' | 'PE';
  expiry: string;
  ltp: number;
  delta: number;
  iv: number;
  expectedProfitPerLot: number;
}

export interface AsymmetricSetupContext {
  token?: string;
  symbol?: string;
  atr14?: number;
  rr?: number;
  entryPrice?: number;
  targetPrice?: number;
  stoplossPrice?: number;
  strikeRec?: AsymmetricStrikeRec | null;
  levelsContext?: Record<string, unknown> | null;
}

export interface AsymmetricSignalRow {
  id: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  targetPrice: number;
  stoplossPrice: number;
  riskRewardRatio: number;
  confidence: string;
  confidenceScore: number;
  strategy: string;
  timeframe: string;
  reason: string;
  createdAt: string | Date;
  isActive: boolean;
  setupContext?: AsymmetricSetupContext | null;
  instrument?: {
    id: string;
    symbol: string;
    token: string;
    exchange: string;
    name?: string;
  };
}

export interface AsymmetricResponse {
  data: AsymmetricSignalRow[];
  total: number;
  lastScanAt: string | null;
  lastResultCount: number;
  isRunning: boolean;
}

export type AsymmetricSortKey = 'rr' | 'time' | 'symbol';

export function useAsymmetricSignals(initialSort: AsymmetricSortKey = 'rr') {
  const [signals, setSignals] = useState<AsymmetricSignalRow[]>([]);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [lastResultCount, setLastResultCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isScanRunning, setIsScanRunning] = useState(false);
  const [sortKey, setSortKey] = useState<AsymmetricSortKey>(initialSort);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSignals = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.get<AsymmetricResponse>('/signals/asymmetric');
      const payload = res.data;
      setSignals(payload?.data ?? []);
      setLastScanAt(payload?.lastScanAt ?? null);
      setLastResultCount(payload?.lastResultCount ?? 0);
    } catch {
      // soft-fail; the inner axios interceptor handles toasts
    } finally {
      setIsLoading(false);
    }
  }, []);

  const triggerScan = useCallback(async () => {
    setIsScanRunning(true);
    try {
      const res = await api.post<{ count: number; symbols: string[] }>(
        '/signals/asymmetric/scan-now',
      );
      const count = res.data?.count ?? 0;
      if (count === 0) {
        toast('No asymmetric setups in this scan');
      } else {
        toast.success(`Asymmetric scan: ${count} setups surfaced`);
      }
      await fetchSignals();
    } catch {
      // soft-fail
    } finally {
      setIsScanRunning(false);
    }
  }, [fetchSignals]);

  useEffect(() => {
    fetchSignals();
    intervalRef.current = setInterval(fetchSignals, REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSignals]);

  const sorted = [...signals].sort((a, b) => {
    switch (sortKey) {
      case 'time':
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      case 'symbol': {
        const sa = a.instrument?.symbol ?? '';
        const sb = b.instrument?.symbol ?? '';
        return sa.localeCompare(sb);
      }
      case 'rr':
      default:
        return b.riskRewardRatio - a.riskRewardRatio;
    }
  });

  return {
    signals: sorted,
    isLoading,
    isScanRunning,
    lastScanAt,
    lastResultCount,
    sortKey,
    setSortKey,
    triggerScan,
    refresh: fetchSignals,
  };
}
