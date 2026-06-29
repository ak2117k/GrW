import { create } from 'zustand';
import type { Quote } from '@/types';
import type { MarketStatus } from '@/types';

interface MarketState {
  quotes: Map<string, Quote>;
  isConnected: boolean;
  marketStatus: MarketStatus;
  updateQuote: (quote: Quote) => void;
  setConnected: (connected: boolean) => void;
  setMarketStatus: (status: MarketStatus) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  quotes: new Map(),
  isConnected: false,
  marketStatus: 'closed',

  updateQuote: (quote) =>
    set((state) => {
      const next = new Map(state.quotes);
      next.set(quote.symbol, quote);
      return { quotes: next };
    }),

  setConnected: (connected) => set({ isConnected: connected }),

  setMarketStatus: (status) => set({ marketStatus: status }),
}));
