import api from './api';
import type { ChartinkScanner, ChartinkAlert } from '@/types';

export async function listScanners(): Promise<ChartinkScanner[]> {
  const r = await api.get<ChartinkScanner[]>('/chartink/scanners');
  return r.data;
}

export async function listAlerts(limit = 50): Promise<ChartinkAlert[]> {
  const r = await api.get<ChartinkAlert[]>('/chartink/alerts', { params: { limit } });
  return r.data;
}

export async function getAlert(id: string): Promise<ChartinkAlert> {
  const r = await api.get<ChartinkAlert>(`/chartink/alerts/${id}`);
  return r.data;
}

// --- Rejections analysis ---------------------------------------------------
// Why Chartink stocks didn't become trades. Contract for
// GET /api/chartink/rejections (built in parallel by the backend).

/** Reason a Chartink hit was rejected at scoring/processing time. */
export type RejectionKind =
  | 'unresolved'
  | 'mtf-misaligned'
  | 'no-direction'
  | 'scored-low'
  | 'macd-misaligned'
  | 'supertrend-misaligned'
  | 'error';

export interface RejectionKindCount {
  kind: string;
  count: number;
}

export interface RejectionSummary {
  totalProcessed: number;
  accepted: number;
  rejected: number;
  /** Rejection kinds only, count desc. */
  byKind: RejectionKindCount[];
}

export interface RejectionScoreCheck {
  name: string;
  points: number;
  pointsPossible: number;
  passed: boolean;
}

export interface RejectionRow {
  id: string;
  processedAt: string; // ISO
  symbol: string;
  scanner: string;
  kind: string;
  reason: string;
  score: number | null;
  hitPrice: number;
  /** Per-factor scoring detail when scoring ran; null for kinds like
   *  `unresolved`, `no-direction`, `error` where scoring never executed. */
  scoreBreakdown: RejectionScoreCheck[] | null;
}

export interface RejectionsResponse {
  range: { from: string; to: string };
  summary: RejectionSummary;
  rejections: RejectionRow[];
}

export interface GetRejectionsParams {
  from?: string; // ISO
  to?: string; // ISO
  kind?: string;
  limit?: number;
}

export async function getRejections(
  params: GetRejectionsParams = {},
): Promise<RejectionsResponse> {
  // Strip undefined values so the request URL stays clean.
  const query: Record<string, string | number> = {};
  if (params.from !== undefined) query.from = params.from;
  if (params.to !== undefined) query.to = params.to;
  if (params.kind !== undefined) query.kind = params.kind;
  if (params.limit !== undefined) query.limit = params.limit;

  const r = await api.get<RejectionsResponse>('/chartink/rejections', {
    params: query,
  });
  return r.data;
}
