import { create } from 'zustand';
import type { AIInsight } from '@/types';
import api from '@/services/api';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  suggestedActions?: string[];
}

export interface WeeklyReport {
  id: string;
  weekStart: string;
  weekEnd: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  overallScore: number;
  createdAt: string;
}

export interface PerformanceSummary {
  summary: string;
  winRate: number;
  totalPnl: number;
  totalTrades: number;
  bestStrategy: string | null;
  worstStrategy: string | null;
  recentStreak: string;
}

export interface TradingSuggestion {
  id: string;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  category: string;
}

interface AdvisorState {
  messages: ChatMessage[];
  insights: AIInsight[];
  reports: WeeklyReport[];
  performanceSummary: PerformanceSummary | null;
  suggestions: TradingSuggestion[];
  isLoading: boolean;
  isTyping: boolean;
  error: string | null;

  sendMessage: (question: string) => Promise<void>;
  fetchInsights: () => Promise<void>;
  fetchReports: (limit?: number) => Promise<void>;
  fetchPerformanceSummary: () => Promise<void>;
  fetchSuggestions: () => Promise<void>;
  generateReport: () => Promise<void>;
  clearMessages: () => void;
}

let messageIdCounter = 0;
function nextId(): string {
  messageIdCounter += 1;
  return `msg-${Date.now()}-${messageIdCounter}`;
}

export const useAdvisorStore = create<AdvisorState>((set, get) => ({
  messages: [],
  insights: [],
  reports: [],
  performanceSummary: null,
  suggestions: [],
  isLoading: false,
  isTyping: false,
  error: null,

  sendMessage: async (question: string) => {
    const userMessage: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: question,
      timestamp: new Date(),
    };

    set((state) => ({
      messages: [...state.messages, userMessage],
      isTyping: true,
    }));

    try {
      const res = await api.post('/advisor/ask', { question });
      const data = res.data;

      const assistantMessage: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: data.answer,
        timestamp: new Date(),
        suggestedActions: data.suggestedActions ?? [],
      };

      set((state) => ({
        messages: [...state.messages, assistantMessage],
        isTyping: false,
      }));
    } catch (err) {
      const assistantMessage: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content:
          'Sorry, I was unable to process your question right now. Please try again.',
        timestamp: new Date(),
      };
      set((state) => ({
        messages: [...state.messages, assistantMessage],
        isTyping: false,
      }));
      console.error('Failed to send advisor message:', err);
    }
  },

  fetchInsights: async () => {
    try {
      const res = await api.get('/advisor/insights');
      set({ insights: res.data ?? [] });
    } catch (err) {
      console.error('Failed to fetch insights:', err);
    }
  },

  fetchReports: async (limit = 5) => {
    try {
      const res = await api.get('/advisor/reports', { params: { limit } });
      set({ reports: res.data ?? [] });
    } catch (err) {
      console.error('Failed to fetch reports:', err);
    }
  },

  fetchPerformanceSummary: async () => {
    try {
      await api.get('/advisor/suggestions');
      // We use the suggestions endpoint; performance summary comes from a
      // dedicated call but we can also build it from the /insights data.
    } catch (err) {
      console.error('Failed to fetch performance summary:', err);
    }
  },

  fetchSuggestions: async () => {
    try {
      const res = await api.get('/advisor/suggestions');
      set({ suggestions: res.data ?? [] });
    } catch (err) {
      console.error('Failed to fetch suggestions:', err);
    }
  },

  generateReport: async () => {
    set({ isLoading: true });
    try {
      await api.post('/advisor/generate-report');
      await get().fetchReports();
    } catch (err) {
      console.error('Failed to generate report:', err);
    } finally {
      set({ isLoading: false });
    }
  },

  clearMessages: () => set({ messages: [] }),
}));
