/** Mirror of the API's portfolio-review report (apps/api/src/modules/portfolio-review/domain/types.ts). */

export type ReviewSegment = 'CASH_HOLDING' | 'CASH_INTRADAY' | 'OPTIONS' | 'FUTURES' | 'COMMODITY';
export type ClosedBy = 'AI_EXIT' | 'MANUAL_IN_APP' | 'PRICE_TRIGGER' | 'EXPIRY' | 'AT_BROKER';
export type OpenedBy = 'MODEL' | 'MANUAL';
export type ExitPriceSource = 'APP_FILL' | 'BROKER_FILL' | 'LAST_TICK';

export interface Bucket {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  gross: number;
  charges: number;
  net: number;
  winRate: number;
  avgNet: number;
}

export interface Headline {
  realisedGross: number;
  charges: number;
  realisedNet: number;
  unrealised: number;
  /** Unrealised on open HOLDINGs only (cash equity). */
  unrealisedHoldings: number;
  /** Unrealised on open POSITIONs (intraday cash, F&O, MCX). */
  unrealisedPositions: number;
  total: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  expectancy: number;
  largestLosses: Array<{ symbol: string; net: number; exitDay: string; segment: ReviewSegment; closedBy: ClosedBy | null }>;
  byMonth: Array<{ month: string; trades: number; gross: number; charges: number; net: number }>;
  openHoldings: number;
  openPositions: number;
  holdingsCost: number;
  holdingsValue: number;
  trackedSince: string | null;
}

export interface Breakdowns {
  bySegment: Bucket[];
  byUnderlying: Bucket[];
  byHoldingPeriod: Bucket[];
  byClosedBy: Bucket[];
  byOpenedBy: Bucket[];
  byOptionDte: Bucket[];
  byOptionPremium: Bucket[];
  byOptionType: Bucket[];
  byEntryTime: Bucket[];
}

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'OK';

export interface Pattern {
  id: string;
  title: string;
  finding: string;
  severity: Severity;
  /** Rupees involved (absolute). */
  rupees: number;
  evidence: Record<string, number | string | null>;
  examples: string[];
}

export interface HoldingTrend {
  status: 'OK' | 'NO_DATA';
  reason?: string;
  bars: number;
  dma50: number | null;
  dma200: number | null;
  high52w: number | null;
  low52w: number | null;
  /** % change over ~6 months (126 sessions, or the available history). */
  ret6m: number | null;
}

export type HoldingTag = 'STRONG' | 'WEAK-TREND' | 'DEAD-MONEY' | 'CONCENTRATED' | 'NEUTRAL';

export interface HoldingCheck {
  symbol: string;
  exchange: string;
  token: string;
  qty: number;
  avgCost: number;
  cost: number;
  ltp: number | null;
  value: number | null;
  pnl: number;
  pnlPct: number;
  daysHeld: number;
  firstTracked: string;
  sharePct: number;
  averagedDown: boolean;
  trend: HoldingTrend;
  tags: HoldingTag[];
  tag: HoldingTag;
  note: string;
}

export interface Suggestion {
  id: string;
  rank: number;
  category: 'RISK' | 'BEHAVIOUR' | 'HOLDING' | 'COST';
  title: string;
  detail: string;
  evidence: string;
  /** Rupees at stake: the loss this behaviour produced, or the capital at risk. */
  impactRupees: number;
}

export interface LlmSummary {
  status: 'OK' | 'SKIPPED' | 'PENDING' | 'BUSY' | 'FAILED';
  text: string | null;
  reason: string | null;
}

export interface PortfolioReview {
  userId: string;
  generatedAt: string;
  headline: Headline;
  breakdowns: Breakdowns;
  patterns: Pattern[];
  holdings: HoldingCheck[];
  suggestions: Suggestion[];
  dataQuality: {
    notes: string[];
    invalidRows: number;
    invalidClaimedPnl: number;
    churnRows: number;
    churnClaimedPnl: number;
    holdingLegs: number;
    lastTickExits: number;
    fillExits: number;
    chargesMethod: string;
  };
  digest: string;
  summary: LlmSummary;
}

export interface ReviewHistoryRow {
  id: string;
  createdAt: string;
  realisedNet: number;
  unrealised: number;
  total: number;
  charges: number;
  trades: number;
  winRate: number;
  summaryStatus: string;
}
