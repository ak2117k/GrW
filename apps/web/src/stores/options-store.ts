import { create } from 'zustand';
import type { OptionsChainEntry } from '@/types';
import api from '@/services/api';

interface OISummary {
  totalCEOI: number;
  totalPEOI: number;
  pcr: number;
  maxPainStrike: number;
  highestCEOIStrike: number;
  highestPEOIStrike: number;
}

interface OptionsState {
  chain: OptionsChainEntry[];
  underlying: string;
  expiry: string;
  expiries: string[];
  spotPrice: number;
  spotChange: number;
  spotChangePercent: number;
  strikeRange: number;
  oiSummary: OISummary | null;
  isLoading: boolean;
  error: string | null;

  setUnderlying: (underlying: string) => void;
  setExpiry: (expiry: string) => void;
  setStrikeRange: (range: number) => void;
  fetchExpiries: () => Promise<void>;
  fetchChain: () => Promise<void>;
  fetchAnalysis: () => Promise<void>;
}

export const useOptionsStore = create<OptionsState>((set, get) => ({
  chain: [],
  underlying: 'NIFTY',
  expiry: '',
  expiries: [],
  spotPrice: 0,
  spotChange: 0,
  spotChangePercent: 0,
  strikeRange: 10,
  oiSummary: null,
  isLoading: false,
  error: null,

  setUnderlying: (underlying) => {
    set({ underlying, chain: [], expiry: '', expiries: [] });
  },

  setExpiry: (expiry) => {
    set({ expiry });
  },

  setStrikeRange: (range) => {
    set({ strikeRange: range });
  },

  fetchExpiries: async () => {
    const { underlying } = get();
    try {
      const res = await api.get(`/options/expiries/${underlying}`);
      const expiries: string[] = res.data.expiries ?? [];
      set({ expiries, expiry: expiries[0] ?? '' });
    } catch (err) {
      set({ error: 'Failed to load expiries' });
    }
  },

  fetchChain: async () => {
    const { underlying, expiry } = get();
    if (!expiry) return;

    set({ isLoading: true, error: null });
    try {
      const res = await api.get(`/options/chain/${underlying}`, {
        params: { expiry },
      });
      const chain: OptionsChainEntry[] = res.data.chain ?? [];

      // Use spot price from API response if available
      let spotPrice = res.data.spotPrice ?? 0;

      // Fallback: estimate spot from chain data
      if (spotPrice === 0 && chain.length > 0) {
        const midIdx = Math.floor(chain.length / 2);
        const midStrike = chain[midIdx].strikePrice;
        let closestDiff = Infinity;
        for (const entry of chain) {
          if (entry.ceData && entry.peData && entry.ceData.ltp > 0 && entry.peData.ltp > 0) {
            const diff = Math.abs(entry.ceData.ltp - entry.peData.ltp);
            if (diff < closestDiff) {
              closestDiff = diff;
              spotPrice = entry.strikePrice;
            }
          }
        }
        if (spotPrice === 0) spotPrice = midStrike;
      }

      set({ chain, spotPrice, isLoading: false });
    } catch (err) {
      set({ error: 'Failed to load options chain', isLoading: false });
    }
  },

  fetchAnalysis: async () => {
    const { underlying, expiry } = get();
    if (!expiry) return;

    try {
      const res = await api.get(`/options/analysis/${underlying}`, {
        params: { expiry },
      });
      set({ oiSummary: res.data });
    } catch {
      // Non-critical — silently fail
    }
  },
}));
