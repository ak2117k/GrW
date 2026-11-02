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
  dma20?: number | null;
  ret1m?: number | null;
  atr14?: number | null;
  lastClose?: number | null;
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
  /** Absent on reviews stored before the action plan existed. */
  actionPlan?: ActionPlan | null;
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

// ---------------------------------------------------------------------------
// Action plan — "what you can do next" (mirror of the API's domain/types.ts)
// ---------------------------------------------------------------------------

export type TrendClass = 'STRONG_UP' | 'UP' | 'WEAK' | 'DOWN' | 'NO_DATA';
export type MomentumClass = 'POSITIVE' | 'FLAT' | 'NEGATIVE' | 'NO_DATA';
export type NewsClass = 'POSITIVE' | 'NEGATIVE' | 'MIXED' | 'NONE';
export type OiClass = 'SUPPORTIVE' | 'NEUTRAL' | 'ADVERSE' | 'NOT_FNO' | 'NO_DATA';
export type OiBuildup = 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'FLAT';
export type Recommendation = 'HOLD' | 'ADD' | 'TRIM' | 'EXIT' | 'SET_STOP';

export interface NewsItem {
  at: string;
  headline: string;
  direction: string;
  magnitude: string;
  oneLine: string;
}

export interface UpcomingEvent {
  kind: string;
  title: string;
  at: string;
}

export interface OiEvidence {
  status: OiClass;
  source: 'BROKER' | 'SNAPSHOTS' | null;
  sessions: number;
  pricePct: number | null;
  oiPct: number | null;
  buildup: OiBuildup | null;
  days: Array<{ date: string; kind: OiBuildup }>;
  reason?: string;
}

export interface Evidence {
  trend: TrendClass;
  momentum: MomentumClass;
  close: number | null;
  dma20: number | null;
  dma50: number | null;
  dma200: number | null;
  ret1m: number | null;
  ret6m: number | null;
  fromHigh52wPct: number | null;
  fromLow52wPct: number | null;
  atr14: number | null;
  news: NewsClass;
  newsItems: NewsItem[];
  oi: OiEvidence;
  events: UpcomingEvent[];
  sector: string | null;
}

export interface EvidenceChip {
  label: string;
  tone: 'good' | 'bad' | 'neutral' | 'info';
}

export interface HoldingAction {
  symbol: string;
  exchange: string;
  token: string;
  recommendation: Recommendation;
  /** Shares to buy (ADD) or sell (TRIM / EXIT); for HOLD / SET_STOP the held quantity the stop covers. */
  qty: number;
  heldQty: number;
  ltp: number | null;
  value: number | null;
  cashImpact: number;
  stop: number | null;
  stopBasis: string;
  pnl: number;
  pnlPct: number;
  daysHeld: number;
  weightPct: number;
  weightAfterPct: number;
  reasons: string[];
  blocked: string[];
  chips: EvidenceChip[];
  evidence: Evidence;
}

export interface NewIdea {
  symbol: string;
  exchange: string;
  token: string;
  sector: string | null;
  close: number;
  qty: number;
  amount: number;
  entryLow: number;
  entryHigh: number;
  stop: number;
  riskRupees: number;
  score: number;
  reasons: string[];
  chips: EvidenceChip[];
  evidence: Evidence;
}

export interface BalanceRead {
  status: 'LIVE' | 'LAST_KNOWN' | 'NO_DATA';
  availableCash: number | null;
  asOf: string | null;
  reason?: string;
}

export interface Sizing {
  balance: BalanceRead;
  cash: number;
  holdingsValue: number;
  totalCapital: number;
  cashPctBefore: number;
  cashPctAfter: number;
  bufferRupees: number;
  freed: number;
  spent: number;
  deployableBefore: number;
  maxWeightBeforePct: number;
  maxWeightAfterPct: number;
  overCapBefore: number;
  overCapAfter: number;
  downTrendPctBefore: number;
  downTrendPctAfter: number;
  riskToStops: number;
  weights: Array<{ symbol: string; beforePct: number; afterPct: number }>;
  /** Cash below the buffer: the shortfall and the weakest holdings to sell first (informational). */
  raiseCash: { needed: number; covered: number; candidates: Array<{ symbol: string; value: number; why: string }> } | null;
  notes: string[];
}

export interface ScreenStats {
  universe: number;
  fetched: number;
  cachedToday: number;
  passedTrend: number;
  oiChecked: number;
  picked: number;
  skippedReason: string | null;
}

export interface ActionPlan {
  generatedAt: string;
  rules: Record<string, number>;
  holdings: HoldingAction[];
  ideas: NewIdea[];
  sizing: Sizing;
  screen: ScreenStats;
  brokerCalls: { used: number; cap: number };
  counts: Record<Recommendation, number>;
  explanation: LlmSummary;
  disclaimer: string;
  dataNotes: string[];
}

export interface ReviewRun {
  id: string;
  userId: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  progress: string | null;
  error: string | null;
  reviewId: string | null;
}

/** The monthly-quota hook. NOT enforced yet: `allowed` is always true. */
export interface ReviewQuota {
  usedThisMonth: number;
  freeLimit: number;
  allowed: boolean;
  enforced: boolean;
  periodStart: string;
  note: string;
}

/** GET /portfolio-review — the latest stored review (never computed on read). */
export interface LatestReviewResponse {
  review: PortfolioReview | null;
  reviewId: string | null;
  activeRun: ReviewRun | null;
  lastRun: ReviewRun | null;
  quota: ReviewQuota;
}

/** POST /portfolio-review/run and GET /portfolio-review/runs/:id. */
export interface RunResponse {
  run: ReviewRun;
  review: PortfolioReview | null;
  quota: ReviewQuota;
}
