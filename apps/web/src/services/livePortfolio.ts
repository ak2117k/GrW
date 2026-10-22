import api from './api';

/**
 * LIVE (real-money) portfolio wire client. Mirrors
 * apps/api/src/modules/portfolio/services/live-performance.service.ts — trades
 * are the caller's broker positions/holdings (trade_trackers) plus live
 * trades-table rows, with who opened/closed each. No paper data.
 */
export type LiveSegment = 'OPTIONS' | 'FUTURES' | 'EQUITY' | 'COMMODITY' | 'CURRENCY';
export type ClosedBy = 'AGENT' | 'MANUAL' | 'TRIGGER' | 'MODEL';
export type OpenedBy = 'MANUAL' | 'MODEL';

export interface LiveTradeRow {
  id: string;
  origin: 'TRACKER' | 'ORDER';
  symbol: string;
  exchange: string;
  segment: LiveSegment;
  kind: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number | null;
  exitPrice: number | null;
  ltp: number | null;
  entryTime: string;
  exitTime: string | null;
  status: 'OPEN' | 'CLOSED';
  pnl: number;
  pnlPercent: number | null;
  openedBy: OpenedBy;
  closedBy: ClosedBy | null;
  strategy: string | null;
  closeNote: string | null;
}

export interface LiveSummary {
  realisedPnl: number;
  todayRealisedPnl: number;
  unrealisedPnl: number;
  openPositions: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  maxDrawdown: number;
}

export interface LiveDashboard {
  summary: LiveSummary;
  equityCurve: Array<{ date: string; equity: number }>;
  dailyPnl: Array<{ date: string; pnl: number }>;
  segments: Array<{ segment: string; pnl: number; trades: number; wins: number; losses: number }>;
  closedBy: Array<{ closedBy: ClosedBy; trades: number; pnl: number }>;
  recent: LiveTradeRow[];
  asOf: string;
}

export async function getLiveDashboard(): Promise<LiveDashboard> {
  const { data } = await api.get<LiveDashboard>('/portfolio/live/dashboard');
  return data;
}

export async function getLiveJournal(): Promise<{ trades: LiveTradeRow[]; total: number }> {
  const { data } = await api.get<{ trades: LiveTradeRow[]; total: number }>('/portfolio/live/journal');
  return { trades: Array.isArray(data?.trades) ? data.trades : [], total: data?.total ?? 0 };
}

// ─── View helpers (pure) ─────────────────────────────────────────────────────

export const CLOSED_BY_LABEL: Record<ClosedBy, string> = {
  AGENT: 'AI agent',
  MANUAL: 'Manual',
  TRIGGER: 'Price trigger',
  MODEL: 'Model',
};

export function closedByLabel(c: ClosedBy | null): string {
  return c ? CLOSED_BY_LABEL[c] : 'Open';
}

/** The last `n` points of a date-sorted series (the Daily P&L bar chart shows ~a month). */
export function lastN<T>(series: T[], n: number): T[] {
  return series.length > n ? series.slice(series.length - n) : series;
}

export type LiveJournalFilter = 'ALL' | 'OPEN' | 'CLOSED' | ClosedBy;

export function filterLiveTrades(rows: LiveTradeRow[], f: LiveJournalFilter): LiveTradeRow[] {
  if (f === 'ALL') return rows;
  if (f === 'OPEN' || f === 'CLOSED') return rows.filter((r) => r.status === f);
  return rows.filter((r) => r.closedBy === f);
}

export interface LiveTotals {
  realised: number;
  unrealised: number;
  closed: number;
  open: number;
  wins: number;
  winRate: number; // 0..100
}

export function liveTotals(rows: LiveTradeRow[]): LiveTotals {
  let realised = 0;
  let unrealised = 0;
  let closed = 0;
  let wins = 0;
  for (const r of rows) {
    if (r.status === 'CLOSED') {
      realised += r.pnl;
      closed += 1;
      if (r.pnl > 0) wins += 1;
    } else {
      unrealised += r.pnl;
    }
  }
  return {
    realised,
    unrealised,
    closed,
    open: rows.length - closed,
    wins,
    winRate: closed > 0 ? (wins / closed) * 100 : 0,
  };
}
