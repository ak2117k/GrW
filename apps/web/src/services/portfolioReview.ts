import api from './api';
import type { PortfolioReview, ReviewHistoryRow } from '@/types/portfolioReview.types';

/**
 * The caller's portfolio review. A fresh computation reads ~1 year of daily candles per holding and may
 * wait for the AI summary, so it gets a longer timeout than the client default.
 */
export async function getPortfolioReview(refresh = false): Promise<PortfolioReview> {
  const { data } = await api.get<PortfolioReview>('/portfolio-review', { params: refresh ? { refresh: 1 } : undefined, timeout: 150_000 });
  return data;
}

export async function getPortfolioReviewHistory(): Promise<ReviewHistoryRow[]> {
  const { data } = await api.get<ReviewHistoryRow[]>('/portfolio-review/history');
  return data;
}
