import api from './api';

/**
 * A single breakout-swing paper-trade row. Distinct from the Anand `AnandEntry`
 * shape: this track rests a LIMIT order at the breakout level, so a row carries
 * resistance / limitPrice / prevDayClose and a trailing stop, and entryPrice is
 * null until the limit fills.
 */
export interface BreakoutSwingEntry {
  id: string;
  symbol: string;
  token: string | null;
  status:
    | 'QUEUED'
    | 'TRADED'
    | 'TARGET_HIT'
    | 'STOPPED'
    | 'BIG_MOVER_EOD'
    | 'EXPIRED'
    | 'DISMISSED';
  signalPrice: number;
  resistance: number;
  limitPrice: number;
  prevDayClose: number;
  entryPrice: number | null; // null until the limit fills
  enteredAt: string | null;
  quantity: number;
  targetPct: number;
  stopPct: number;
  trailing: boolean;
  trailingHighWater: number | null;
  stopPrice: number | null;
  currentPrice: number | null;
  lastTickAt: string | null;
  exitPrice: number | null;
  exitedAt: string | null;
  exitReason: string | null;
  queuedAt: string;
  createdAt: string;
}

export interface BreakoutSwingCapital {
  baseCapital: number;
  investedOpen: number;
  realizedPnl: number;
  available: number;
  openCount: number;
}

export async function listBreakoutSwingEntries(params: { from?: string } = {}): Promise<
  BreakoutSwingEntry[]
> {
  const r = await api.get<BreakoutSwingEntry[]>('/breakout-swing/entries', { params });
  return r.data;
}

export async function getBreakoutSwingCapital(): Promise<BreakoutSwingCapital> {
  const r = await api.get<BreakoutSwingCapital>('/breakout-swing/capital');
  return r.data;
}

export async function cancelBreakoutSwingOrder(id: string): Promise<void> {
  await api.post(`/breakout-swing/${id}/cancel`);
}
