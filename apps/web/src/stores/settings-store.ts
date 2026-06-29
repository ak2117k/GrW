import { create } from 'zustand';
import type { TradingSettings } from '@/types';
import { AutoTradeMode, Segment } from '@/types';
import api from '@/services/api';

const defaultSettings: TradingSettings = {
  autoTradeMode: AutoTradeMode.OFF,
  paperTrading: true,
  maxDailyLoss: 5000,
  maxCapitalPerTrade: 25000,
  maxConcurrentPositions: 5,
  defaultRiskRewardRatio: 2,
  activeStrategies: [],
  preferredSegments: [Segment.EQUITY, Segment.OPTIONS],
  tradingHoursOnly: true,
};

interface SettingsState {
  settings: TradingSettings;
  isLoading: boolean;
  updateSettings: (partial: Partial<TradingSettings>) => void;
  loadSettings: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: defaultSettings,
  isLoading: false,

  updateSettings: (partial) =>
    set((state) => ({
      settings: { ...state.settings, ...partial },
    })),

  loadSettings: async () => {
    set({ isLoading: true });
    try {
      const { data } = await api.get<TradingSettings>('/settings');
      set({ settings: data });
    } catch {
      console.warn('Failed to load settings, using defaults');
    } finally {
      set({ isLoading: false });
    }
  },
}));
