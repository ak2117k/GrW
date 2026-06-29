import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface WatchlistItem {
  symbol: string;
  token: string;
  exchange: string;
  name: string;
}

interface WatchlistState {
  watchlist: WatchlistItem[];
  addToWatchlist: (item: WatchlistItem) => void;
  removeFromWatchlist: (token: string) => void;
  reorderWatchlist: (fromIndex: number, toIndex: number) => void;
}

const DEFAULT_WATCHLIST: WatchlistItem[] = [
  { symbol: 'NIFTY', token: '99926000', exchange: 'NSE', name: 'Nifty 50' },
  { symbol: 'BANKNIFTY', token: '99926009', exchange: 'NSE', name: 'Bank Nifty' },
  { symbol: 'RELIANCE', token: '2885', exchange: 'NSE', name: 'Reliance Industries' },
  { symbol: 'TCS', token: '11536', exchange: 'NSE', name: 'Tata Consultancy Services' },
  { symbol: 'HDFCBANK', token: '1333', exchange: 'NSE', name: 'HDFC Bank' },
  { symbol: 'GOLD', token: '477904', exchange: 'MCX', name: 'Gold' },
  { symbol: 'NATURALGAS', token: '538685', exchange: 'MCX', name: 'Natural Gas' },
];

export const useWatchlistStore = create<WatchlistState>()(
  persist(
    (set) => ({
      watchlist: DEFAULT_WATCHLIST,

      addToWatchlist: (item) =>
        set((state) => {
          if (state.watchlist.some((w) => w.token === item.token)) return state;
          return { watchlist: [...state.watchlist, item] };
        }),

      removeFromWatchlist: (token) =>
        set((state) => ({
          watchlist: state.watchlist.filter((w) => w.token !== token),
        })),

      reorderWatchlist: (fromIndex, toIndex) =>
        set((state) => {
          const list = [...state.watchlist];
          const [moved] = list.splice(fromIndex, 1);
          list.splice(toIndex, 0, moved);
          return { watchlist: list };
        }),
    }),
    {
      name: 'td-watchlist',
    },
  ),
);
