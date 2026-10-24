import api from '@/services/api';

export interface BacktestDataset {
  id: number;
  symbol: string;
  exchange: string;
  interval: string;
  fromTs: string | null;
  toTs: string | null;
  rows: number;
  source: string;
  updatedAt: string;
}

export interface AssistantStatus {
  allowed: boolean;
  dailyCap?: number;
  usedToday?: number;
  maxBars?: number;
  fetchLimits?: { maxCallsPerRequest: number; maxCallsPerDay: number; marketHoursMaxCalls: number };
}

export type AssistantRequestStatus =
  | 'queued'
  | 'spec'
  | 'fetching'
  | 'running'
  | 'summarising'
  | 'done'
  | 'refused'
  | 'error';

export interface AssistantMetrics {
  trades: number;
  winRate: number;
  profitFactor: number | null;
  profitFactorAfterCosts: number | null;
  netPnl: number;
  returnPct: number;
  returnAfterCostsPct: number;
  estCosts: number;
  expectancy: number;
  expectancyAfterCosts: number;
  maxDrawdownPct: number;
  avgHoldHours: number;
  costBpsPerSide: number;
  byYear: Array<{ year: number; trades: number; winRate: number; pnl: number; pnlAfterCosts: number }>;
  data?: { source: string; bars: number; firstBar: string; lastBar: string; partial: boolean; fetch: { status: string; message: string; calls: number } | null };
}

export interface AssistantRequest {
  id: string;
  prompt: string;
  status: AssistantRequestStatus;
  progress: { phase?: string; calls?: number; budget?: number; windowsDone?: number; windowsTotal?: number; rows?: number } | null;
  spec: (Record<string, unknown> & { resolved?: { from: string; to: string; described: string } }) | null;
  runId: string | null;
  metrics: AssistantMetrics | null;
  summary: string | null;
  error: string | null;
  llmCalls: number;
  cachedFrom: string | null;
  createdAt: string;
}

const unwrap = <T,>(res: { data: any }): T => (res.data?.data ?? res.data) as T;

export async function getAssistantStatus(): Promise<AssistantStatus> {
  return unwrap(await api.get('/backtest/assistant/status'));
}

export async function askBacktestAssistant(prompt: string): Promise<AssistantRequest> {
  return unwrap(await api.post('/backtest/assistant/ask', { prompt }));
}

export async function getAssistantRequest(id: string): Promise<AssistantRequest> {
  return unwrap(await api.get(`/backtest/assistant/requests/${id}`));
}

export async function listBacktestDatasets(symbol?: string): Promise<BacktestDataset[]> {
  return unwrap(await api.get('/backtest/data/datasets', { params: symbol ? { symbol } : undefined }));
}
