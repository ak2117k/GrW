import { create } from 'zustand';
import type { OptionsChainEntry } from '@/types';
import api from '@/services/api';
import type { ChainMeta } from '@/utils/chainAge';

interface OptionsState {
  chain: OptionsChainEntry[];
  underlying: string;
  expiry: string;
  expiries: string[];
  spotPrice: number;
  spotChange: number;
  spotChangePercent: number;
  strikeRange: number;
  chainMeta: ChainMeta | null;
  isLoading: boolean;
  error: string | null;

  setUnderlying: (underlying: string) => void;
  setExpiry: (expiry: string) => void;
  setStrikeRange: (range: number) => void;
  fetchExpiries: () => Promise<void>;
  fetchChain: () => Promise<void>;
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
  chainMeta: null,
  isLoading: false,
  error: null,

  setUnderlying: (underlying) => {
    set({ underlying, chain: [], expiry: '', expiries: [], chainMeta: null });
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
      const chainMeta: ChainMeta = {
        at: res.data.at ?? null,
        source: res.data.source ?? null,
        status: res.data.status ?? null,
      };

      // Use spot price from API response if available (null when the hub obtained no spot)
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

      set({ chain, spotPrice, chainMeta, isLoading: false });
    } catch (err) {
      // Keep the last chain on screen and say why it did not refresh.
      const reason = (err as { response?: { status?: number; data?: { reason?: string } } })?.response;
      const error = reason?.status === 503
        ? `Option chain unavailable${reason.data?.reason ? ` (${reason.data.reason})` : ''}`
        : 'Failed to load options chain';
      set({ error, isLoading: false });
    }
  },
}));
