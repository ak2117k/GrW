import { create } from 'zustand';
import type { PortfolioSummary } from '@/types';
import api from '@/services/api';

export interface EquityPoint {
  date: string;
  equity: number;
}

export interface DailyPnLPoint {
  date: string;
  pnl: number;
}

export interface SegmentStats {
  segment: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
}

export interface RecentTrade {
  id: string;
  side: string;
  pnl: number | null;
  pnlPercent: number | null;
  status: string;
  strategy: string | null;
  quantity: number;
  entryPrice: number | null;
  exitPrice: number | null;
  createdAt: string;
  instrument: {
    symbol: string;
    exchange: string;
    segment: string;
  };
}

interface PortfolioState {
  summary: PortfolioSummary | null;
  equityCurve: EquityPoint[];
  dailyPnl: DailyPnLPoint[];
  segmentBreakdown: SegmentStats[];
  recentTrades: RecentTrade[];
  isLoading: boolean;
  error: string | null;

  fetchSummary: () => Promise<void>;
  fetchEquityCurve: (from?: string, to?: string) => Promise<void>;
  fetchDailyPnl: (from?: string, to?: string) => Promise<void>;
  fetchSegmentBreakdown: () => Promise<void>;
  fetchRecentTrades: () => Promise<void>;
  fetchAll: () => Promise<void>;
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  summary: null,
  equityCurve: [],
  dailyPnl: [],
  segmentBreakdown: [],
  recentTrades: [],
  isLoading: false,
  error: null,

  fetchSummary: async () => {
    try {
      const res = await api.get('/portfolio/summary');
      set({ summary: res.data });
    } catch (err) {
      console.error('Failed to fetch portfolio summary:', err);
    }
  },

  fetchEquityCurve: async (from?: string, to?: string) => {
    try {
      const params: Record<string, string> = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await api.get('/portfolio/equity-curve', { params });
      set({ equityCurve: res.data ?? [] });
    } catch (err) {
      console.error('Failed to fetch equity curve:', err);
    }
  },

  fetchDailyPnl: async (from?: string, to?: string) => {
    try {
      const params: Record<string, string> = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await api.get('/portfolio/daily-pnl', { params });
      set({ dailyPnl: res.data ?? [] });
    } catch (err) {
      console.error('Failed to fetch daily P&L:', err);
    }
  },

  fetchSegmentBreakdown: async () => {
    try {
      const res = await api.get('/portfolio/segments');
      set({ segmentBreakdown: res.data ?? [] });
    } catch (err) {
      console.error('Failed to fetch segment breakdown:', err);
    }
  },

  fetchRecentTrades: async () => {
    try {
      const res = await api.get('/portfolio/journal', {
        params: { limit: 5, page: 1 },
      });
      const data = res.data;
      set({ recentTrades: data.trades ?? [] });
    } catch (err) {
      console.error('Failed to fetch recent trades:', err);
    }
  },

  fetchAll: async () => {
    set({ isLoading: true, error: null });
    try {
      await Promise.all([
        get().fetchSummary(),
        get().fetchEquityCurve(),
        get().fetchDailyPnl(),
        get().fetchSegmentBreakdown(),
        get().fetchRecentTrades(),
      ]);
    } catch (err) {
      set({ error: 'Failed to load portfolio data' });
    } finally {
      set({ isLoading: false });
    }
  },
}));
