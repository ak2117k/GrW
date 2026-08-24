import { create } from 'zustand';
import type { Quote } from '@/types';
import type { MarketStatus } from '@/types';
import type { FeedHealth } from '@/services/feed-health';

interface MarketState {
  quotes: Map<string, Quote>;
  isConnected: boolean;
  /**
   * Tick-feed health. Distinct from `isConnected`, which only says a socket
   * somewhere is up — `/ws/telegram` being connected told us nothing about
   * whether prices were arriving, and the badge said "Live" anyway.
   */
  feedHealth: FeedHealth;
  marketStatus: MarketStatus;
  updateQuote: (quote: Quote) => void;
  setConnected: (connected: boolean) => void;
  setFeedHealth: (health: FeedHealth) => void;
  setMarketStatus: (status: MarketStatus) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  quotes: new Map(),
  isConnected: false,
  // Starts offline: before a tick has arrived we have no evidence of a feed,
  // and absence of evidence must not render as health.
  feedHealth: 'offline',
  marketStatus: 'closed',

  updateQuote: (quote) =>
    set((state) => {
      const next = new Map(state.quotes);
      next.set(quote.symbol, quote);
      return { quotes: next };
    }),

  setConnected: (connected) => set({ isConnected: connected }),

  setFeedHealth: (health) => set({ feedHealth: health }),

  setMarketStatus: (status) => set({ marketStatus: status }),
}));
