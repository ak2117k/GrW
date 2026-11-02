import api from './api';
import type { LatestReviewResponse, ReviewHistoryRow, ReviewQuota, RunResponse } from '@/types/portfolioReview.types';

/** The latest STORED review + the run in progress + the quota. Never starts a review. */
export async function getLatestPortfolioReview(): Promise<LatestReviewResponse> {
  const { data } = await api.get<LatestReviewResponse>('/portfolio-review');
  return data;
}

/**
 * Start a review run (the "Run portfolio review" button). The server answers within ~15 s: DONE with
 * the review, or RUNNING with a run id to poll ({@link getPortfolioReviewRun}).
 */
export async function runPortfolioReview(): Promise<RunResponse> {
  const { data } = await api.post<RunResponse>('/portfolio-review/run', undefined, { timeout: 60_000 });
  return data;
}

export async function getPortfolioReviewRun(id: string): Promise<RunResponse> {
  const { data } = await api.get<RunResponse>(`/portfolio-review/runs/${encodeURIComponent(id)}`);
  return data;
}

export async function getPortfolioReviewQuota(): Promise<ReviewQuota> {
  const { data } = await api.get<ReviewQuota>('/portfolio-review/quota');
  return data;
}

export async function getPortfolioReviewHistory(): Promise<ReviewHistoryRow[]> {
  const { data } = await api.get<ReviewHistoryRow[]>('/portfolio-review/history');
  return data;
}
