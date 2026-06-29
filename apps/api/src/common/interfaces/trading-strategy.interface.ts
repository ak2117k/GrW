/**
 * Trading Strategy Interface
 *
 * All trading algorithms implement this interface.
 * To add a new strategy, create a new class that implements
 * TradingStrategy and register it in the signal-generator module.
 */

export interface MarketSnapshot {
  symbol: string;
  exchange: string;
  ltp: number;
  candles: CandleData[];
  oi?: number;
  oiChange?: number;
  volume: number;
  /**
   * Optional multi-timeframe candle data for strategies that need to
   * evaluate conditions across several intervals at once (e.g. a 15m
   * strategy that also checks 1m / 5m / 1h alignment). Existing
   * single-timeframe strategies ignore this field; MTF-aware ones
   * read from `mtfCandles['1m']`, `mtfCandles['5m']`, etc.
   */
  mtfCandles?: Record<string, CandleData[]>;
}

export interface CandleData {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalOutput {
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  targetPrice: number;
  stoplossPrice: number;
  confidence: number; // 0-100
  reason: string;
  timeframe: string;
  metadata?: Record<string, any>;
}

export interface BacktestInput {
  candles: CandleData[];
  initialCapital: number;
  positionSize: number;
  /**
   * Optional instrument/run context. Existing single-symbol strategies that
   * only need the `candles` array ignore these. Strategies that replay an
   * external scoring pipeline "as of a past timestamp" (e.g. the Chartink
   * 10-check backtest) read them to know WHICH instrument and date window
   * they are evaluating. All optional so no existing strategy breaks.
   */
  symbol?: string;
  token?: string;
  exchange?: string;
  timeframe?: string;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Per-bar diagnostic record for a backtest entry-scan iteration.
 *
 * Pure observability — records the score/gate values the strategy already
 * computed at a bar and the entry decision it made. Strategies that don't
 * produce one simply leave `BacktestResult.barLog` absent.
 */
export interface BacktestBarLog {
  /** ISO timestamp of the bar that was scanned for entry. */
  time: string;
  /** The 0-100 chartink score computed as-of that bar. */
  score: number;
  dataStarved: boolean;
  /** Did the 'MACD on 5m' check pass. */
  macd5m: boolean;
  /** Did the 'SuperTrend match' check pass. */
  supertrend: boolean;
  decision: 'entered' | 'skipped';
  /** '' when entered; else why the bar was skipped. */
  reason: string;
}

export interface BacktestResult {
  totalTrades: number;
  winRate: number;
  totalReturn: number;
  totalReturnPercent: number;
  maxDrawdown: number;
  sharpeRatio: number;
  trades: BacktestTrade[];
  /**
   * Optional per-bar entry-decision diagnostics. Only strategies that opt in
   * (currently `chartink-gated`) populate this; all other strategies and the
   * backtest service are unaffected by its absence.
   */
  barLog?: BacktestBarLog[];
}

export interface BacktestTrade {
  entryTime: Date;
  exitTime: Date;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  reason: string;
}

export interface TradingStrategy {
  /** Unique name of the strategy */
  readonly name: string;

  /** Human-readable description */
  readonly description: string;

  /** Which segments this strategy supports */
  readonly supportedSegments: string[];

  /** Which timeframes this strategy works best with */
  readonly preferredTimeframes: string[];

  /** Analyze current market data and return a signal or null */
  analyze(data: MarketSnapshot): SignalOutput | null;

  /**
   * Run backtest against historical data. May be synchronous (the legacy
   * single-symbol strategies) or asynchronous (strategies that fetch extra
   * data, e.g. an as-of replay of the Chartink scoring pipeline).
   */
  backtest(input: BacktestInput): BacktestResult | Promise<BacktestResult>;

  /** Get current strategy parameters */
  getParameters(): Record<string, any>;

  /** Update strategy parameters */
  setParameters(params: Record<string, any>): void;
}
