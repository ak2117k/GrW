import { create } from 'zustand';
import api from '@/services/api';
import { presetRange } from '@/utils/backtestDateRange';

export interface BacktestTradeResult {
  entryTime: string;
  exitTime: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  reason: string;
}

export interface BacktestResultData {
  totalTrades: number;
  winRate: number;
  totalReturn: number;
  totalReturnPercent: number;
  maxDrawdown: number;
  sharpeRatio: number;
  trades: BacktestTradeResult[];
}

export interface BacktestConfig {
  strategy: string;
  symbol: string;
  exchange: string;
  timeframe: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  positionSize: number;
}

export interface BacktestHistoryItem {
  id: string;
  strategy: string;
  parameters: Record<string, any>;
  startDate: string;
  endDate: string;
  totalTrades: number;
  winRate: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpeRatio: number;
  results: BacktestResultData;
  createdAt: string;
}

export interface ComparisonResultData {
  configs: BacktestConfig[];
  results: Array<BacktestResultData & { strategy: string }>;
}

interface BacktestState {
  config: BacktestConfig;
  results: BacktestResultData | null;
  comparison: ComparisonResultData | null;
  history: BacktestHistoryItem[];
  selectedRun: BacktestHistoryItem | null;
  isRunning: boolean;
  isLoadingHistory: boolean;
  compareConfigs: BacktestConfig[];
  isCompareMode: boolean;

  updateConfig: (partial: Partial<BacktestConfig>) => void;
  runBacktest: () => Promise<void>;
  compareStrategies: () => Promise<void>;
  fetchHistory: () => Promise<void>;
  loadBacktest: (id: string) => Promise<void>;
  deleteBacktest: (id: string) => Promise<void>;
  addToCompare: (config: BacktestConfig) => void;
  removeFromCompare: (index: number) => void;
  toggleCompareMode: () => void;
  clearResults: () => void;
}

const defaultConfig: BacktestConfig = {
  strategy: '',
  symbol: '',
  exchange: 'NSE',
  timeframe: '1d',
  // Open run-ready on a sensible window (last 3 months → today) instead of
  // blank fields; the user can still pick any range or use a preset.
  ...presetRange('3M'),
  initialCapital: 1000000,
  positionSize: 1,
};

export const useBacktestStore = create<BacktestState>((set, get) => ({
  config: { ...defaultConfig },
  results: null,
  comparison: null,
  history: [],
  selectedRun: null,
  isRunning: false,
  isLoadingHistory: false,
  compareConfigs: [],
  isCompareMode: false,

  updateConfig: (partial) => {
    set((state) => ({
      config: { ...state.config, ...partial },
    }));
  },

  runBacktest: async () => {
    const { config } = get();
    set({ isRunning: true, results: null, comparison: null });
    try {
      const res = await api.post('/backtest/run', {
        ...config,
        startDate: new Date(config.startDate).toISOString(),
        endDate: new Date(config.endDate).toISOString(),
      });
      const data: BacktestResultData = res.data?.data ?? res.data;
      set({ results: data, isRunning: false });
      // Refresh history after a run
      get().fetchHistory();
    } catch {
      set({ isRunning: false });
    }
  },

  compareStrategies: async () => {
    const { compareConfigs } = get();
    if (compareConfigs.length < 2) return;
    set({ isRunning: true, results: null, comparison: null });
    try {
      const res = await api.post('/backtest/compare', {
        configs: compareConfigs.map((c) => ({
          ...c,
          startDate: new Date(c.startDate).toISOString(),
          endDate: new Date(c.endDate).toISOString(),
        })),
      });
      const data: ComparisonResultData = res.data?.data ?? res.data;
      set({ comparison: data, isRunning: false });
      get().fetchHistory();
    } catch {
      set({ isRunning: false });
    }
  },

  fetchHistory: async () => {
    set({ isLoadingHistory: true });
    try {
      const res = await api.get('/backtest');
      const runs: BacktestHistoryItem[] = res.data?.data ?? res.data ?? [];
      set({ history: runs, isLoadingHistory: false });
    } catch {
      set({ isLoadingHistory: false });
    }
  },

  loadBacktest: async (id: string) => {
    try {
      const res = await api.get(`/backtest/${id}`);
      const run: BacktestHistoryItem = res.data?.data ?? res.data;
      set({
        selectedRun: run,
        results: run.results,
        comparison: null,
      });
    } catch {
      // Error handled by api interceptor
    }
  },

  deleteBacktest: async (id: string) => {
    try {
      await api.delete(`/backtest/${id}`);
      set((state) => ({
        history: state.history.filter((h) => h.id !== id),
        selectedRun:
          state.selectedRun?.id === id ? null : state.selectedRun,
      }));
    } catch {
      // Error handled by api interceptor
    }
  },

  addToCompare: (config) => {
    set((state) => {
      if (state.compareConfigs.length >= 5) return state;
      return { compareConfigs: [...state.compareConfigs, config] };
    });
  },

  removeFromCompare: (index) => {
    set((state) => ({
      compareConfigs: state.compareConfigs.filter((_, i) => i !== index),
    }));
  },

  toggleCompareMode: () => {
    set((state) => ({
      isCompareMode: !state.isCompareMode,
      comparison: null,
      compareConfigs: state.isCompareMode ? [] : state.compareConfigs,
    }));
  },

  clearResults: () => {
    set({ results: null, comparison: null, selectedRun: null });
  },
}));
