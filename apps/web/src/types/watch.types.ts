export type WatchStatus =
  | 'WATCHING' | 'TRADED' | 'TARGET_HIT' | 'STOPPED' | 'EXITED' | 'DISMISSED'
  // Alert that reached its level but was never executed (e.g. gate-rejected).
  | 'MISSED';

export type WatchEventType =
  | 'INITIAL' | 'PRICE_CHANGE' | 'SCORE_CHANGE' | 'TARGET_HIT'
  | 'SL_HIT_SCORE' | 'SL_HIT_PRICE' | 'TRADE_OPENED' | 'TRADE_CLOSED' | 'DISMISSED'
  | 'PARTIAL_EXIT' | 'TRAILING_STOP_HIT' | 'NOT_TRADED';

export interface WatchEntry {
  id: string;
  alertId: string | null;
  setupId: string | null;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: unknown;
  /**
   * Latest rescored breakdown — same shape as `initialBreakdown`, or `null`
   * if the entry has never been rescored. Server-enriched.
   */
  currentBreakdown: unknown;
  initialAt: string;
  profitTarget: number;
  profitTargetSource: 'indicator-sr' | 'fallback-2pct';
  stopLossScore: number;
  status: WatchStatus;
  currentPrice: number | null;
  currentScore: number | null;
  maxFavorable: number | null;
  maxAdverse: number | null;
  lastTickAt: string | null;
  lastRescoreAt: string | null;
  optionsToken: string | null;
  optionsType: 'CE' | 'PE' | null;
  optionsExpiry: string | null;
  optionsStrike: number | null;
  optionsLotSize: number | null;
  optionsSelectionScore: number | null;
  paperTradeId: string | null;
  liveTradeId: string | null;
  executedAt: string | null;
  executedPrice: number | null;
  /** Actual filled quantity — the real position size (server-enriched). */
  quantity: number | null;
  closedAt: string | null;
  closedReason: string | null;
  notes: string | null;
  partialExitedAt: string | null;
  partialExitPrice: number | null;
  partialQty: number | null;
  remainingQty: number | null;
  trailingHighWater: number | null;
  trailingStopPrice: number | null;
  /** Chartink scanner that triggered this entry (server-enriched). */
  scannerName: string | null;
  /** Realized P/L of the linked trade once closed (server-enriched). */
  realizedPnl: number | null;
  /** Round-trip SEBI/exchange/brokerage charges on the linked trade. Null
   *  alongside `realizedPnl == null`. Surfaced on the watch-page footer to
   *  show the structural charge drag separately from price-only P&L. */
  realizedFees: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WatchEvent {
  id: string;
  watchEntryId: string;
  eventType: WatchEventType;
  price: number | null;
  score: number | null;
  breakdown: unknown;
  priceDelta: number | null;
  scoreDelta: number | null;
  notes: string | null;
  createdAt: string;
}

export interface WatchEntryWithEvents extends WatchEntry {
  events: WatchEvent[];
}
