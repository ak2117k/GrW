import { create } from 'zustand';
import type { TradeSignal, SignalConfidence, Segment } from '@/types';
import api from '@/services/api';

export interface SignalFilters {
  strategy: string;
  segment: string;
  minConfidence: string;
  isActive: boolean;
  /**
   * When true (default), hide signals whose `createdAt` is before
   * today's local-midnight. Belt-and-braces guard against the
   * /signals page surfacing weeks-old rows even if a backend sweep
   * misses a legacy null-expiry row.
   */
  todayOnly: boolean;
  sortBy: 'confidence' | 'time' | 'riskReward';
}

interface SignalState {
  signals: TradeSignal[];
  filters: SignalFilters;
  isLoading: boolean;
  isScanRunning: boolean;
  newSignalIds: Set<string>;

  fetchSignals: () => Promise<void>;
  addSignal: (signal: TradeSignal) => void;
  removeSignal: (id: string) => void;
  updateFilters: (partial: Partial<SignalFilters>) => void;
  triggerScan: () => Promise<void>;
  clearNewFlag: (id: string) => void;
}

const CONFIDENCE_ORDER: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  VERY_HIGH: 4,
};

function matchesMinConfidence(
  confidence: SignalConfidence,
  min: string,
): boolean {
  if (min === 'all') return true;
  const level = CONFIDENCE_ORDER[confidence] ?? 0;
  const minLevel = CONFIDENCE_ORDER[min] ?? 0;
  return level >= minLevel;
}

export const useSignalStore = create<SignalState>((set, get) => ({
  signals: [],
  filters: {
    strategy: 'all',
    segment: 'all',
    minConfidence: 'all',
    isActive: true,
    todayOnly: true,
    sortBy: 'confidence',
  },
  isLoading: false,
  isScanRunning: false,
  newSignalIds: new Set(),

  fetchSignals: async () => {
    set({ isLoading: true });
    try {
      // recentHours=12 — also include signals that expired within the
      // last 12h. With session-aware TTLs (NSE 15:30 / MCX 23:30 IST),
      // 12h covers a full session of context. Each signal still carries
      // its own isActive flag so the UI can fade expired ones.
      const res = await api.get('/signals/active', { params: { recentHours: 12 } });
      const signals: TradeSignal[] = (res.data?.data ?? res.data ?? []).map(
        (s: TradeSignal) => ({
          ...s,
          createdAt: new Date(s.createdAt),
        }),
      );
      set({ signals, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  addSignal: (signal) => {
    set((state) => {
      const exists = state.signals.some((s) => s.id === signal.id);
      if (exists) return state;
      const newIds = new Set(state.newSignalIds);
      newIds.add(signal.id);
      return {
        signals: [
          { ...signal, createdAt: new Date(signal.createdAt) },
          ...state.signals,
        ],
        newSignalIds: newIds,
      };
    });
  },

  removeSignal: (id) => {
    // Don't drop the row when a signal expires — flip its isActive flag
    // instead so the SignalCard fades to "EXPIRED" but stays visible
    // for the rest of the recent-window. Drop it from state only on
    // re-fetch when it falls outside the 12h recent window.
    set((state) => ({
      signals: state.signals.map((s) =>
        s.id === id ? { ...s, isActive: false } : s,
      ),
    }));
  },

  updateFilters: (partial) => {
    set((state) => ({
      filters: { ...state.filters, ...partial },
    }));
  },

  triggerScan: async () => {
    set({ isScanRunning: true });
    try {
      await api.post('/signals/scan');
      await get().fetchSignals();
    } finally {
      set({ isScanRunning: false });
    }
  },

  clearNewFlag: (id) => {
    set((state) => {
      const newIds = new Set(state.newSignalIds);
      newIds.delete(id);
      return { newSignalIds: newIds };
    });
  },
}));

// Selectors
export function selectFilteredSignals(state: SignalState): TradeSignal[] {
  const { signals, filters } = state;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();

  let filtered = signals.filter((s) => {
    if (filters.strategy !== 'all' && s.strategy !== filters.strategy)
      return false;
    if (
      filters.segment !== 'all' &&
      s.segment !== (filters.segment as Segment)
    )
      return false;
    if (!matchesMinConfidence(s.confidence, filters.minConfidence))
      return false;
    if (filters.todayOnly) {
      const createdMs = new Date(s.createdAt).getTime();
      if (createdMs < startOfTodayMs) return false;
    }
    return true;
  });

  // Sort
  filtered = [...filtered].sort((a, b) => {
    switch (filters.sortBy) {
      case 'confidence':
        return b.confidenceScore - a.confidenceScore;
      case 'time':
        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      case 'riskReward':
        return b.riskRewardRatio - a.riskRewardRatio;
      default:
        return 0;
    }
  });

  return filtered;
}

export function selectActiveCount(state: SignalState): number {
  // Only true-active signals count toward the headline metric. Expired
  // ones are kept in state for visibility but shouldn't inflate the
  // "active" KPI.
  return state.signals.filter((s) => s.isActive).length;
}

export function selectAvgConfidence(state: SignalState): number {
  const active = state.signals.filter((s) => s.isActive);
  if (active.length === 0) return 0;
  const sum = active.reduce((acc, s) => acc + s.confidenceScore, 0);
  return Math.round(sum / active.length);
}
