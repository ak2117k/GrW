import { useEffect, useRef, useCallback, useMemo } from 'react';
import {
  useSignalStore,
  selectActiveCount,
  selectAvgConfidence,
} from '@/stores/signal-store';
import { wsService } from '@/services/websocket';
import type { TradeSignal, Segment } from '@/types';

const REFRESH_INTERVAL = 30_000;

function matchesMinConfidence(confidence: string, min: string): boolean {
  const order = ['LOW', 'MEDIUM', 'HIGH'];
  return order.indexOf(confidence) >= order.indexOf(min);
}

export function useSignals() {
  const fetchSignals = useSignalStore((s) => s.fetchSignals);
  const addSignal = useSignalStore((s) => s.addSignal);
  const removeSignal = useSignalStore((s) => s.removeSignal);
  const triggerScan = useSignalStore((s) => s.triggerScan);
  const isLoading = useSignalStore((s) => s.isLoading);
  const isScanRunning = useSignalStore((s) => s.isScanRunning);
  const rawSignals = useSignalStore((s) => s.signals);
  const filters = useSignalStore((s) => s.filters);
  const activeCount = useSignalStore(selectActiveCount);
  const avgConfidence = useSignalStore(selectAvgConfidence);

  const signals = useMemo(() => {
    // Today-only cutoff — recompute per render so a session that crosses
    // midnight rolls forward without a manual reload.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayMs = startOfToday.getTime();

    let filtered = rawSignals.filter((s) => {
      if (filters.strategy !== 'all' && s.strategy !== filters.strategy) return false;
      if (filters.segment !== 'all' && s.segment !== (filters.segment as Segment)) return false;
      if (!matchesMinConfidence(s.confidence, filters.minConfidence)) return false;
      if (filters.todayOnly) {
        const createdMs = new Date(s.createdAt).getTime();
        if (createdMs < startOfTodayMs) return false;
      }
      return true;
    });

    filtered = [...filtered].sort((a, b) => {
      switch (filters.sortBy) {
        case 'confidence':
          return b.confidenceScore - a.confidenceScore;
        case 'time':
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'riskReward':
          return b.riskRewardRatio - a.riskRewardRatio;
        default:
          return 0;
      }
    });

    return filtered;
  }, [rawSignals, filters]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchSignals();

    // Auto-refresh
    intervalRef.current = setInterval(fetchSignals, REFRESH_INTERVAL);

    // WebSocket subscriptions
    const unsubNew = wsService.subscribe('signal', (data) => {
      const payload = data as { type?: string; signal?: TradeSignal; signalId?: string };
      if (payload.type === 'new-signal' && payload.signal) {
        addSignal(payload.signal);
      } else if (payload.type === 'signal-expired' && payload.signalId) {
        removeSignal(payload.signalId);
      } else if (payload.signal) {
        // Fallback: treat any signal event with a signal payload as new
        addSignal(payload.signal);
      }
    });

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      unsubNew();
    };
  }, [fetchSignals, addSignal, removeSignal]);

  const handleTriggerScan = useCallback(() => {
    triggerScan();
  }, [triggerScan]);

  return {
    signals,
    activeCount,
    avgConfidence,
    isLoading,
    isScanRunning,
    triggerScan: handleTriggerScan,
  };
}
