import { create } from 'zustand';
import type { NewsItem } from '@/types';
import api from '@/services/api';

export interface NewsFilters {
  category: string; // 'all' | 'indian' | 'global' | 'sector' | 'company'
  sentiment: string; // 'all' | 'bullish' | 'bearish' | 'neutral'
  source: string; // 'all' | source name
  search: string;
}

interface NewsResponse {
  data: NewsItem[];
  total: number;
  page: number;
  limit: number;
}

interface NewsState {
  articles: NewsItem[];
  filters: NewsFilters;
  isLoading: boolean;
  isRefreshing: boolean;
  total: number;
  page: number;
  lastUpdated: Date | null;

  fetchNews: (page?: number) => Promise<void>;
  addArticle: (article: NewsItem) => void;
  updateFilters: (partial: Partial<NewsFilters>) => void;
  refreshNews: () => Promise<void>;
  loadMore: () => Promise<void>;
}

export const useNewsStore = create<NewsState>((set, get) => ({
  articles: [],
  filters: {
    category: 'all',
    sentiment: 'all',
    source: 'all',
    search: '',
  },
  isLoading: false,
  isRefreshing: false,
  total: 0,
  page: 1,
  lastUpdated: null,

  fetchNews: async (page = 1) => {
    set({ isLoading: true });
    try {
      const { filters } = get();
      const params: Record<string, string | number> = { page, limit: 20 };

      if (filters.category !== 'all') params.category = filters.category;
      if (filters.sentiment !== 'all') params.sentiment = filters.sentiment;
      if (filters.source !== 'all') params.source = filters.source;
      if (filters.search) params.search = filters.search;

      const res = await api.get<NewsResponse>('/news', { params });
      const response = res.data;

      const articles = (response.data ?? []).map((a: NewsItem) => ({
        ...a,
        publishedAt: new Date(a.publishedAt),
      }));

      set({
        articles: page === 1 ? articles : [...get().articles, ...articles],
        total: response.total,
        page,
        isLoading: false,
        lastUpdated: new Date(),
      });
    } catch {
      set({ isLoading: false });
    }
  },

  addArticle: (article) => {
    set((state) => {
      const exists = state.articles.some((a) => a.id === article.id);
      if (exists) return state;
      return {
        articles: [
          { ...article, publishedAt: new Date(article.publishedAt) },
          ...state.articles,
        ],
        total: state.total + 1,
      };
    });
  },

  updateFilters: (partial) => {
    set((state) => ({
      filters: { ...state.filters, ...partial },
    }));
    // Re-fetch from page 1 when filters change
    get().fetchNews(1);
  },

  refreshNews: async () => {
    set({ isRefreshing: true });
    try {
      await api.post('/news/refresh');
      // Small delay to let the queue process
      await new Promise((r) => setTimeout(r, 2000));
      await get().fetchNews(1);
    } finally {
      set({ isRefreshing: false });
    }
  },

  loadMore: async () => {
    const { page, total, articles } = get();
    if (articles.length >= total) return;
    await get().fetchNews(page + 1);
  },
}));

// Selectors
export function selectSentimentCounts(state: NewsState) {
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const article of state.articles) {
    const s = article.sentiment as keyof typeof counts;
    if (s in counts) counts[s]++;
  }
  return counts;
}

export function selectTrendingSymbols(state: NewsState): { symbol: string; count: number }[] {
  const symbolMap = new Map<string, number>();
  for (const article of state.articles) {
    for (const symbol of article.relatedSymbols) {
      symbolMap.set(symbol, (symbolMap.get(symbol) ?? 0) + 1);
    }
  }
  return Array.from(symbolMap.entries())
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

export function selectSources(state: NewsState): string[] {
  const sourceSet = new Set<string>();
  for (const article of state.articles) {
    sourceSet.add(article.source);
  }
  return Array.from(sourceSet).sort();
}
