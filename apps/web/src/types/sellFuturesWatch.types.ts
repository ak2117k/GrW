import type { WatchEntry } from './watch.types';

/**
 * SELL-Futures track entry. Shape parity with the shadow/ungated watch entry
 * (so the shared `WatchTable` renders it unchanged) plus the futures-leg
 * fields the backend enriches. `side` is always 'SELL' for this track.
 */
export interface SellFuturesWatchEntry extends WatchEntry {
  eqToken?: string;
  futTradingsymbol?: string;
  futExpiry?: string;
  lotSize?: number;
}

export interface SellFuturesPaperAccount {
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
