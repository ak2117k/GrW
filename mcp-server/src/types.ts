/** Shared types for the TD MCP server. */

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  statusCode?: number;
}

export interface Instrument {
  symbol: string;
  token: string;
  name: string;
  exchange: string;
  segment: string;
  lotSize: number;
  tickSize: number;
  expiry: string | null;
  strike: number | null;
  optionType: string | null;
}

export interface Quote {
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change?: number;
  changePercent?: number;
}

export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeRequest {
  symbol: string;
  token: string;
  exchange: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT" | "STOP_MARKET" | "STOP_LIMIT";
  quantity: number;
  price?: number;
  triggerPrice?: number;
  positionType: "INTRADAY" | "DELIVERY" | "CARRYFORWARD";
  stoploss?: number;
  target?: number;
  strategy?: string;
  isPaper?: boolean;
}

export interface Trade {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  entryPrice: number;
  exitPrice?: number;
  pnl?: number;
  status: string;
  strategy?: string;
  isPaper: boolean;
}

export interface Signal {
  id: string;
  symbol: string;
  side: string;
  strategy: string;
  confidence: number;
  entryPrice: number;
  stoploss: number;
  target: number;
  status: string;
  createdAt: string;
}

export interface RiskStatus {
  dailyPnl: number;
  maxDailyLoss: number;
  openPositions: number;
  maxPositions: number;
  capitalDeployed: number;
  killSwitchActive: boolean;
}
