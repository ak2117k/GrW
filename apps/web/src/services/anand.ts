import api from './api';

export interface AnandEntry {
  id: string;
  symbol: string;
  token: string | null;
  entryPrice: number;
  enteredAt: string;
  targetPct: number;
  stopPct: number;
  status: string;
  exitPrice: number | null;
  exitedAt: string | null;
  currentPrice: number | null;  // null when no live price + no level-book seed (stale)
  pnlPct: number | null;        // null when price is unavailable (see priceStale)
  targetLeftPct: number | null;
  priceStale?: boolean;         // true when neither live LTP nor level-book seed had a price
  scannerName: string | null;   // resolved from alertId on the backend
  scoreBreakdown: Array<{ name: string; points: number; pointsPossible: number; passed: boolean }> | null;
  leadCount?: number;           // Feature 1: how many times this symbol led (swing)
  leadDates?: string[];         // lossless ISO-timestamp lead log
  trailing?: boolean;           // Feature 3: intraday trailing-stop armed
  exitReason?: string | null;   // set only on trailed exits: TRAIL_ST | TRAIL_GB (null for plain target/stop/expire)
}

export interface PnlPeriod {
  avgExitPct: number;
  count: number;
  winCount: number;
  totalPnlRs: number;
}

export interface PnlSummary {
  daily: PnlPeriod;
  weekly: PnlPeriod;
  monthly: PnlPeriod;
  yearly: PnlPeriod;
}

export async function listIntradayEntries(params: {
  status?: string; from?: string; to?: string;
} = {}): Promise<AnandEntry[]> {
  const r = await api.get<AnandEntry[]>('/anand/intraday/entries', { params });
  return r.data;
}

export async function listSwingEntries(params: {
  status?: string; from?: string; to?: string;
} = {}): Promise<AnandEntry[]> {
  const r = await api.get<AnandEntry[]>('/anand/swing/entries', { params });
  return r.data;
}

export async function listSwingExits(params: {
  from?: string; to?: string; status?: string;
} = {}): Promise<AnandEntry[]> {
  const r = await api.get<AnandEntry[]>('/anand/swing/exits', { params });
  return r.data;
}

export interface SwingCapital {
  baseCapital: number;
  investedOpen: number;
  realizedPnl: number;
  available: number;
  openCount: number;
}

export async function getSwingCapital(): Promise<SwingCapital> {
  const r = await api.get<SwingCapital>('/anand/swing/capital');
  return r.data;
}

export async function getIntradayPnl(): Promise<PnlSummary> {
  const r = await api.get<PnlSummary>('/anand/intraday/pnl-summary');
  return r.data;
}

export async function getSwingPnl(): Promise<PnlSummary> {
  const r = await api.get<PnlSummary>('/anand/swing/pnl-summary');
  return r.data;
}

export interface ReinvestPool {
  harvestedTotal: number;
  deployedActive: number;
  idleBalance: number;
  realizedPnl: number;
  // Live mark-to-market across all OPEN lots, summed server-side so it stays
  // correct regardless of the page's row filter.
  unrealizedPnl: number;
}

export interface ReinvestLot {
  id: string;
  symbol: string;
  sourceSwingEntryId: string;
  capital: number;
  entryPrice: number;
  enteredAt: string;
  targetPct: number;
  stopPct: number;
  status: string;        // OPEN | TARGET_HIT | STOPPED
  exitPrice: number | null;
  exitedAt: string | null;
  exitReason: string | null;
  currentPrice: number;
  pnlPct: number;
  pnlRs: number;
}

export async function getReinvestPool(): Promise<ReinvestPool> {
  const r = await api.get<ReinvestPool>('/anand/reinvest/pool');
  return r.data;
}

export async function listReinvestLots(status?: string): Promise<ReinvestLot[]> {
  const r = await api.get<ReinvestLot[]>('/anand/reinvest/lots', { params: { status } });
  return r.data;
}

export interface SwingDailyOhlcRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  phase: 'HOLD' | 'POST_EXIT';
}

export interface SwingDailyOhlcResponse {
  entry: {
    id: string;
    symbol: string;
    enteredAt: string;
    exitedAt: string | null;
    status: string;
  };
  rows: SwingDailyOhlcRow[];
}

export async function getSwingDailyOhlc(id: string): Promise<SwingDailyOhlcResponse> {
  const r = await api.get<SwingDailyOhlcResponse>(`/anand/swing/${id}/daily-ohlc`);
  return r.data;
}
