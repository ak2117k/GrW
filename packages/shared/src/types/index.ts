// ============================================
// Core Trading Types
// ============================================

export enum Segment {
  EQUITY = 'EQUITY',
  FUTURES = 'FUTURES',
  OPTIONS = 'OPTIONS',
  COMMODITY = 'COMMODITY',
}

export enum Exchange {
  NSE = 'NSE',
  BSE = 'BSE',
  MCX = 'MCX',
  NFO = 'NFO',
  CDS = 'CDS',
}

export enum OrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  STOPLOSS = 'STOPLOSS',
  STOPLOSS_MARKET = 'STOPLOSS_MARKET',
}

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum PositionType {
  INTRADAY = 'INTRADAY',
  DELIVERY = 'DELIVERY',
  CARRYFORWARD = 'CARRYFORWARD',
}

export enum OptionType {
  CE = 'CE',
  PE = 'PE',
}

export enum SignalConfidence {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  VERY_HIGH = 'VERY_HIGH',
}

export enum TradeStatus {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
  REJECTED = 'REJECTED',
}

export enum AutoTradeMode {
  OFF = 'OFF',
  APPROVAL_REQUIRED = 'APPROVAL_REQUIRED',
  FULLY_AUTOMATIC = 'FULLY_AUTOMATIC',
  PAPER_TRADING = 'PAPER_TRADING',
}

// ---- Market Data ----

export interface Quote {
  symbol: string;
  token: string;
  exchange: Exchange;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
  timestamp: Date;
  /** Intraday VWAP from LevelBookService when available. Optional — not all
   *  tokens are tracked by the level book (e.g. tokens outside the universe). */
  vwap?: number;
}

export interface Candle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OIData {
  symbol: string;
  token: string;
  oi: number;
  oiChange: number;
  oiChangePercent: number;
  timestamp: Date;
}

// ---- Market Depth ----

export interface MarketDepthLevel {
  price: number;
  qty: number;
  orders: number;
}

export interface MarketDepth {
  token: string;
  exchange: string;
  /** Up to 5 levels; sorted with best bid first (highest price). */
  bids: MarketDepthLevel[];
  /** Up to 5 levels; sorted with best ask first (lowest price). */
  asks: MarketDepthLevel[];
  totalBidQty: number;
  totalAskQty: number;
  /** Server timestamp (ms epoch) when the snapshot was taken. */
  ts: number;
}

export interface OptionsChainEntry {
  strikePrice: number;
  expiryDate: string;
  ceData: OptionData | null;
  peData: OptionData | null;
}

export interface OptionData {
  ltp: number;
  oi: number;
  oiChange: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  bidPrice: number;
  askPrice: number;
}

// ---- Signals ----

export interface TradeSignal {
  id: string;
  symbol: string;
  exchange: Exchange;
  segment: Segment;
  side: OrderSide;
  optionType?: OptionType;
  strikePrice?: number;
  expiry?: string;
  entryPrice: number;
  targetPrice: number;
  stoplossPrice: number;
  expectedProfit: number;
  expectedLoss: number;
  riskRewardRatio: number;
  confidence: SignalConfidence;
  confidenceScore: number; // 0-100
  strategy: string;
  reason: string;
  timeframe: string;
  createdAt: Date;
  /**
   * Lifecycle flag set by the backend. A signal is created with
   * `isActive: true`; a sweep flips it to `false` once its session-aware
   * `expiresAt` passes (and emits a `signal-expired` ws event). The
   * /signals/active endpoint still returns recently-expired rows carrying
   * this flag so the UI can fade them rather than drop them. Optional to
   * match the backend DTO and tolerate constructors that omit it (absent
   * is treated as expired).
   */
  isActive?: boolean;
}

// ---- Orders & Positions ----

export interface OrderRequest {
  symbol: string;
  token: string;
  exchange: Exchange;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  positionType: PositionType;
}

export interface Position {
  symbol: string;
  exchange: Exchange;
  side: OrderSide;
  quantity: number;
  averagePrice: number;
  ltp: number;
  pnl: number;
  pnlPercent: number;
}

export interface Trade {
  id: string;
  symbol: string;
  exchange: Exchange;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  entryPrice: number;
  exitPrice?: number;
  ltp: number;
  pnl: number;
  pnlPercent: number;
  status: TradeStatus;
  strategy: string;
  positionType: PositionType;
  stoploss?: number;
  target?: number;
  isPaper: boolean;
  createdAt: Date;
  closedAt?: Date;
}

export type TradeEventType =
  | 'OPENED'
  | 'CLOSED'
  | 'MODIFIED'
  | 'REJECTED'
  | 'SL_HIT'
  | 'TARGET_HIT';

export interface TradeEvent {
  id: string;
  timestamp: Date;
  eventType: TradeEventType;
  symbol: string;
  side: OrderSide;
  price: number;
  quantity: number;
  pnl?: number;
  message?: string;
}

export interface RiskStatus {
  dailyLossUsed: number;
  dailyLossLimit: number;
  positionsUsed: number;
  positionsLimit: number;
  capitalDeployed: number;
  capitalLimit: number;
}

// ---- Portfolio ----

export interface PortfolioSummary {
  totalPnl: number;
  todayPnl: number;
  weekPnl: number;
  monthPnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  maxDrawdown: number;
  sharpeRatio: number;
}

// ---- Settings ----

export interface TradingSettings {
  autoTradeMode: AutoTradeMode;
  paperTrading: boolean;
  maxDailyLoss: number;
  maxCapitalPerTrade: number;
  maxConcurrentPositions: number;
  defaultRiskRewardRatio: number;
  activeStrategies: string[];
  preferredSegments: Segment[];
  tradingHoursOnly: boolean;
}

// ---- AI Advisor ----

export interface AIInsight {
  id: string;
  type: 'suggestion' | 'warning' | 'analysis' | 'report';
  title: string;
  content: string;
  actionable: boolean;
  createdAt: Date;
}

// ---- News ----

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  category: 'indian' | 'global' | 'sector' | 'company';
  sentiment: 'bullish' | 'bearish' | 'neutral';
  relatedSymbols: string[];
  publishedAt: Date;
}
