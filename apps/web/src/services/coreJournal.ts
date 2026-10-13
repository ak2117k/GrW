import api from './api';

/**
 * SP2 M5: the caller's core journal. Mirrors the wire shapes of
 * apps/api/src/modules/trade-core/journal/controllers/core-journal.controller.ts (the API does not import @td/shared).
 */
export interface CoreTradeSummaryView {
  positionId: string;
  intentId: string;
  strategyId: string;
  vehicle: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  entryAvgPrice: string;
  exitAvgPrice: string;
  openedAt: string;
  closedAt: string;
  grossPnl: string;
  charges: string;
  mtfInterest: string;
  netPnl: string;
  initialRisk: string | null;
  rMultiple: string | null;
  mfeRupees: string | null;
  maeRupees: string | null;
  holdMinutes: number;
  exitReason: string;
}

export interface CoreJournalRowView {
  id: string;
  type: string;
  positionId: string | null;
  strategyId: string | null;
  intentId: string | null;
  symbol: string | null;
  payload: Record<string, unknown>;
  priceUsed: number | null;
  priceAgeMs: number | null;
  createdAt: string;
}

export interface CoreDailySummaryView {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: string | null;
  grossPnl: string;
  costs: string;
  netPnl: string;
  costsPctOfGross: string | null;
}

export interface CoreJournalDayView {
  day: string;
  summary: CoreDailySummaryView;
  trades: CoreTradeSummaryView[];
  setups: number;
  skips: Record<string, number>;
  latched: boolean;
  notices: CoreJournalRowView[];
}

export interface CorePositionTimelineView {
  position: { id: string; status: string; side: 'BUY' | 'SELL'; instrument: { symbol: string }; exitReason: string | null };
  events: CoreJournalRowView[];
  summary: CoreTradeSummaryView | null;
}

export interface CoreJournalStatusView {
  entries: { mode: 'off' | 'journal' | 'paper'; users: number; pending: number; dropped: number };
  journal: { pending: number; written: number; dropped: number; failures: number; lastError: string | null };
  positions: { active: number; blind: number; exiting: number };
  mismatches: CoreJournalRowView[];
}

export interface CoreComparisonRowView {
  alertId: string;
  symbol: string | null;
  token: string;
  strategyKey: string;
  intentId: string;
  core: { outcome: 'TRADED' | 'OPEN' | 'SKIPPED' | 'PENDING'; reason: string | null; netPnl: string | null; qty: number | null };
  silo: { track: 'adaptive-stop' | 'ungated'; status: string; pnl: number | null; fees: number | null; exitReason: string | null } | null;
}

export async function getCoreJournalDay(day?: string): Promise<CoreJournalDayView> {
  return (await api.get<CoreJournalDayView>('/trade-core/journal/day', { params: day ? { day } : {} })).data;
}

export async function getCorePositionTimeline(id: string): Promise<CorePositionTimelineView> {
  return (await api.get<CorePositionTimelineView>(`/trade-core/journal/positions/${encodeURIComponent(id)}`)).data;
}

export async function getCoreJournalStatus(): Promise<CoreJournalStatusView> {
  return (await api.get<CoreJournalStatusView>('/trade-core/journal/status')).data;
}

export async function ackReconFinding(id: string, reason: string): Promise<{ acknowledged: string }> {
  return (await api.post<{ acknowledged: string }>(`/trade-core/journal/recon/${encodeURIComponent(id)}/ack`, { reason })).data;
}

export async function getCoreComparison(day?: string): Promise<CoreComparisonRowView[]> {
  return (await api.get<CoreComparisonRowView[]>('/trade-core/journal/comparison', { params: day ? { day } : {} })).data;
}
