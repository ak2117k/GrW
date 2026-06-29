import type { WatchEntry } from './watch.types';

export type UngatedWatchEntry = WatchEntry; // shape parity guaranteed by spec §4

export interface UngatedPaperAccount {
  id: string;
  startingBalance: number;
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  deployedCapital: number;
  equity: number;
  killSwitchAt: string | null;
}

export interface DailyComparison {
  date: string;
  gated:   { tradeCount: number; gross: number; charges: number; net: number };
  ungated: {
    tradeCount: number; gross: number; charges: number; net: number;
    rejected: Record<string, number>;
  };
  edge: { netDiff: number; verdict: string };
}
