/**
 * Portfolio review types. The domain is pure: the service reads rows, these
 * functions compute, the LLM only explains the computed numbers.
 */

/** One trade_trackers row (the real broker book), as the service reads it. */
export interface TrackerInput {
  id: string;
  symbol: string;
  exchange: string;
  token: string;
  kind: string; // POSITION | HOLDING
  entryPrice: number;
  qty: number;
  entryTime: Date;
  exitPrice: number | null;
  exitTime: Date | null;
  status: string; // OPEN | CLOSED
  holdingHigh: number | null;
  holdingLow: number | null;
  lastLtp: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  updatedAt?: Date | null;
}

/** A live exit the app sent (ai_exit_executions, PLACED/FILLED, mode live). */
export interface ExitInput {
  trackerId: string;
  verdictId: string;
  status: string;
  fillPrice: number | null;
  createdAt: Date;
}

/** A LIVE (isPaperTrade=false) trades row — only used to say who OPENED a trade. */
export interface OrderInput {
  token: string | null;
  source: string;
  at: Date;
}

export type ReviewSegment = 'CASH_HOLDING' | 'CASH_INTRADAY' | 'OPTIONS' | 'FUTURES' | 'COMMODITY';
export type ClosedBy = 'AI_EXIT' | 'MANUAL_IN_APP' | 'PRICE_TRIGGER' | 'EXPIRY' | 'AT_BROKER';
export type OpenedBy = 'MODEL' | 'MANUAL';
export type ExitPriceSource = 'APP_FILL' | 'BROKER_FILL' | 'LAST_TICK';

/**
 * One real trade after de-duplication: consecutive tracker rows of the same
 * holding (or the same contract at the same average price) are ONE episode —
 * the tracker closes and re-opens rows when a position blinks out of the broker
 * book, and every such close carries the mark-to-market P&L at that moment.
 */
export interface Episode {
  key: string;
  rowIds: string[];
  symbol: string;
  underlying: string;
  exchange: string;
  token: string;
  kind: 'POSITION' | 'HOLDING';
  segment: ReviewSegment;
  side: 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED';
  /** |qty| of the last row (open qty, or the qty closed at the end). */
  qty: number;
  /** Average price of the last row. */
  entryPrice: number;
  firstEntry: string; // ISO
  exitTime: string | null; // ISO
  exitPrice: number | null;
  exitPriceSource: ExitPriceSource | null;
  ltp: number | null;
  /** Realised gross P&L (partial exits + final exit), rupees. 0 for an untouched open episode. */
  realisedGross: number;
  /** Unrealised mark-to-market on the open quantity, rupees. 0 for a closed episode. */
  unrealised: number;
  /** Estimated round-trip charges on the closed quantity, rupees. */
  charges: number;
  holdingHigh: number | null;
  holdingLow: number | null;
  /** Entry notional of the largest quantity held, rupees. */
  entryNotional: number;
  maxQty: number;
  adds: number;
  averagedDown: boolean;
  partialExits: number;
  /** Quantity sold before the final exit (or while still open). */
  partialQty: number;
  lastPartialAt: string | null;
  closedBy: ClosedBy | null;
  openedBy: OpenedBy;
  /** Option / future details when the symbol parses as a derivative. */
  derivative: {
    type: 'CE' | 'PE' | 'FUT';
    expiry: string;
    strike: number | null;
    dteAtEntry: number;
    /** Option premium as % of strike — a moneyness proxy (no spot at entry is stored). */
    premiumPctOfStrike: number | null;
  } | null;
  /** Cash POSITION rows that are really a holding's buy/sell legs are excluded from trade stats. */
  role: 'TRADE' | 'HOLDING_LEG';
  flags: string[];
}

export interface EpisodeBuild {
  episodes: Episode[];
  /** Tracker rows dropped as unusable (entryPrice ≤ 0, qty 0) and the P&L they claimed. */
  invalid: { rows: number; claimedPnl: number; symbols: string[] };
  /** Closed tracker rows that were re-opened (churn), and the P&L their closes claimed. */
  churn: { rows: number; claimedPnl: number };
  holdingLegs: number;
}

/** A closed trade with net P&L, the unit every metric is computed on. */
export interface ClosedTrade extends Episode {
  net: number;
  holdingDays: number;
  holdingBucket: 'INTRADAY' | '1-5D' | '>5D';
  entryHourBucket: string;
  /** Gross P&L as % of entry notional. */
  returnPct: number;
  peakOpenProfit: number | null;
  gaveBack: number;
}

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
  /** 20-DMA (optional: reviews stored before the action plan do not carry it). */
  dma20?: number | null;
  /** % change over ~1 month (20 sessions). */
  ret1m?: number | null;
  /** 14-session average true range, rupees. */
  atr14?: number | null;
  /** Last daily close. */
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
  /** The forward-looking plan (absent on reviews stored before the action plan existed). */
  actionPlan?: ActionPlan | null;
}

// ---------------------------------------------------------------------------
// Action plan — "what you can do next" (owner 2026-11-02)
// ---------------------------------------------------------------------------

/** Price trend from daily candles vs the 20/50/200-DMA (evidence.ts classifyTrend). */
export type TrendClass = 'STRONG_UP' | 'UP' | 'WEAK' | 'DOWN' | 'NO_DATA';
export type MomentumClass = 'POSITIVE' | 'FLAT' | 'NEGATIVE' | 'NO_DATA';
export type NewsClass = 'POSITIVE' | 'NEGATIVE' | 'MIXED' | 'NONE';
/** Futures OI over the last sessions: price × OI direction. */
export type OiClass = 'SUPPORTIVE' | 'NEUTRAL' | 'ADVERSE' | 'NOT_FNO' | 'NO_DATA';
export type OiBuildup = 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'FLAT';

/** One recent material (MED+, non-recap) news read for a symbol. */
export interface NewsItem {
  at: string; // ISO
  headline: string;
  direction: string; // BULL | BEAR | NEUTRAL
  magnitude: string; // MED | HIGH
  oneLine: string;
}

/** One upcoming company event (market_events, scope company). */
export interface UpcomingEvent {
  kind: string; // results | board_meeting | ex_dividend | split | bonus | corporate_action
  title: string;
  at: string; // ISO
}

/** Futures OI evidence: the window's aggregate build-up plus the daily kinds. */
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
  /** % below the 52-week high (≥ 0). */
  fromHigh52wPct: number | null;
  /** % above the 52-week low (≥ 0). */
  fromLow52wPct: number | null;
  atr14: number | null;
  news: NewsClass;
  newsItems: NewsItem[];
  oi: OiEvidence;
  events: UpcomingEvent[];
  sector: string | null;
}

export type Recommendation = 'HOLD' | 'ADD' | 'TRIM' | 'EXIT' | 'SET_STOP';

/** A short label + tone for the UI's evidence chips. */
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
  /** Rupees: + spent (ADD), − freed (TRIM / EXIT), 0 otherwise. */
  cashImpact: number;
  /** Protective stop (rupees per share), null without a price. */
  stop: number | null;
  stopBasis: string;
  pnl: number;
  pnlPct: number;
  daysHeld: number;
  /** Share of total capital (cash + holdings value), %, before and after the plan. */
  weightPct: number;
  weightAfterPct: number;
  /** The rule hits behind the recommendation, in plain words. */
  reasons: string[];
  /** Rules that blocked an ADD (e.g. no averaging down). */
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
  /** Rupees lost if the stop is hit from the top of the entry zone. */
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

export interface WeightRow {
  symbol: string;
  beforePct: number;
  afterPct: number;
}

export interface Sizing {
  balance: BalanceRead;
  /** Cash used in the math (0 when the balance is unknown). */
  cash: number;
  holdingsValue: number;
  totalCapital: number;
  cashPctBefore: number;
  cashPctAfter: number;
  /** The buffer the plan keeps in cash (rupees, cashBufferPct × capital). */
  bufferRupees: number;
  /** Rupees freed by TRIM / EXIT at the last price. */
  freed: number;
  /** Rupees the ADDs and new ideas would spend. */
  spent: number;
  /** Cash above the buffer before the plan (negative = below the buffer). */
  deployableBefore: number;
  maxWeightBeforePct: number;
  maxWeightAfterPct: number;
  overCapBefore: number;
  overCapAfter: number;
  /** Share of capital in stocks below their long trend (DOWN), before → after. */
  downTrendPctBefore: number;
  downTrendPctAfter: number;
  /** Rupees lost if every stop in the plan is hit (holdings kept + new ideas). */
  riskToStops: number;
  weights: WeightRow[];
  /**
   * When cash is below the buffer: the rupees needed to restore it and the weakest holdings by the
   * rules that would be sold first (dead money + below the long trend, then below the long trend,
   * then dead money). Informational — these rows keep their own recommendation.
   */
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

/** One portfolio_review_runs row (each explicit "Run portfolio review"). */
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
  periodStart: string; // IST month 'YYYY-MM'
  note: string;
}
