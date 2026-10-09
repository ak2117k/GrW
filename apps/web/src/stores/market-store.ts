import { create } from 'zustand';
import type { Quote } from '@/types';
import type { MarketStatus } from '@/types';
import type { FeedHealth } from '@/services/feed-health';
import type { FeedSource } from '@/services/browser-feed';

interface MarketState {
  quotes: Map<string, Quote>;
  isConnected: boolean;
  /**
   * Tick-feed health. Distinct from `isConnected`, which only says a socket
   * somewhere is up — `/ws/telegram` being connected told us nothing about
   * whether prices were arriving, and the badge said "Live" anyway.
   */
  feedHealth: FeedHealth;
  /** Which path feeds this browser ('hub' lets screens stop polling while Live); null until the server says. */
  feedSource: FeedSource | null;
  marketStatus: MarketStatus;
  updateQuote: (quote: Quote) => void;
  setConnected: (connected: boolean) => void;
  setFeedHealth: (health: FeedHealth) => void;
  setFeedSource: (source: FeedSource | null) => void;
  setMarketStatus: (status: MarketStatus) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  quotes: new Map(),
  isConnected: false,
  // Starts offline: before a tick has arrived we have no evidence of a feed,
  // and absence of evidence must not render as health.
  feedHealth: 'offline',
  feedSource: null,
  marketStatus: 'closed',

  updateQuote: (quote) =>
    set((state) => {
      const next = new Map(state.quotes);
      next.set(quote.symbol, quote);
      return { quotes: next };
    }),

  setConnected: (connected) => set({ isConnected: connected }),

  setFeedHealth: (health) => set({ feedHealth: health }),

  setFeedSource: (source) => set({ feedSource: source }),

  setMarketStatus: (status) => set({ marketStatus: status }),
}));
