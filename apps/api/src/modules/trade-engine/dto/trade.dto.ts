import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsInt,
  IsArray,
  Min,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum OrderSideDto {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum OrderTypeDto {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  STOPLOSS = 'STOPLOSS',
  STOPLOSS_MARKET = 'STOPLOSS_MARKET',
}

export enum PositionTypeDto {
  INTRADAY = 'INTRADAY',
  DELIVERY = 'DELIVERY',
  CARRYFORWARD = 'CARRYFORWARD',
}

/**
 * Structured exit-reason tag captured on every trade close.
 * The journal uses these to bucket outcomes — "did the trade hit target,
 * stop out, get exited early, etc.?" — so the trader can see WHICH kind
 * of exits are draining their P&L (e.g. lots of PANIC_EXITs ⇒ discipline
 * issue, not strategy issue).
 */
export enum ExitReasonTag {
  HIT_TARGET = 'HIT_TARGET',
  STOPPED_OUT = 'STOPPED_OUT',
  MOVED_STOP = 'MOVED_STOP',
  PANIC_EXIT = 'PANIC_EXIT',
  TIME_EXIT = 'TIME_EXIT',
  REVERSAL_SEEN = 'REVERSAL_SEEN',
  OTHER = 'OTHER',
}

export class ExecuteTradeDto {
  @IsString()
  symbol: string;

  @IsString()
  token: string;

  @IsString()
  exchange: string;

  @IsEnum(OrderSideDto)
  side: OrderSideDto;

  @IsEnum(OrderTypeDto)
  orderType: OrderTypeDto;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsNumber()
  price?: number;

  @IsOptional()
  @IsNumber()
  triggerPrice?: number;

  @IsEnum(PositionTypeDto)
  positionType: PositionTypeDto;

  @IsOptional()
  @IsNumber()
  stoploss?: number;

  @IsOptional()
  @IsNumber()
  target?: number;

  /** Free-text "why this trade" reason captured at entry. Optional — the
   *  UI strongly encourages it for journal quality but server doesn't enforce. */
  @IsOptional()
  @IsString()
  entryReason?: string;

  /** Tag chips selected at entry (e.g. ["OI_BUILDUP","VWAP_RECLAIM"]).
   *  Used by the journal for bucket-by-setup analysis. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  entryTags?: string[];

  @IsOptional()
  @IsString()
  signalId?: string;

  @IsOptional()
  @IsString()
  strategy?: string;

  /** Per-order paper/live override. When omitted, execution falls back to the
   *  global `settings.paperTrading` (which defaults to paper). An explicit
   *  `false` is the ONLY way to route a single order live — a missing flag
   *  must NEVER default to live. */
  @IsOptional()
  @IsBoolean()
  isPaper?: boolean;

  /** Origin track of the order. Defaults to 'MANUAL' (user-placed) when
   *  omitted — the manual controller path relies on this default. Non-manual
   *  call sites (watch / auto-trade / scanner) set it explicitly so the
   *  manual-trade page can scope its ledger to MANUAL trades only. */
  @IsOptional()
  @IsEnum(['MANUAL', 'WATCH', 'AUTO', 'SCANNER'])
  source?: 'MANUAL' | 'WATCH' | 'AUTO' | 'SCANNER';
}

export class ModifyTradeDto {
  @IsOptional()
  @IsNumber()
  stoploss?: number;

  @IsOptional()
  @IsNumber()
  target?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;
}

export class CloseTradeDto {
  /** Structured exit-reason tag — drives journal exit-bucket analysis. */
  @IsOptional()
  @IsEnum(ExitReasonTag)
  exitReasonTag?: ExitReasonTag;

  /** Free-text exit notes (what actually happened, optional). */
  @IsOptional()
  @IsString()
  exitNotes?: string;

  /** @deprecated Prefer exitReasonTag + exitNotes. Kept for backwards
   *  compatibility with older clients that POST `{reason: "..."}`. */
  @IsOptional()
  @IsString()
  reason?: string;
}

export class CloseAllTradesDto {
  @IsString()
  reason: string;
}

export class TradeFilterDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  strategy?: string;

  @IsOptional()
  @IsString()
  segment?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isPaperTrade?: boolean;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** Filter by VIX regime captured at entry: LOW | NORMAL | ELEVATED | HIGH | UNKNOWN. */
  @IsOptional()
  @IsString()
  vixRegime?: string;

  /** Filter by structured exit-reason tag (matches ExitReasonTag values). */
  @IsOptional()
  @IsString()
  exitReasonTag?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

/** Return type for risk validation. */
export interface RiskValidation {
  allowed: boolean;
  reason?: string;
}

/** Daily risk status snapshot. */
export interface DailyRiskStatus {
  dailyLossUsed: number;
  dailyLossLimit: number;
  positionsUsed: number;
  positionsLimit: number;
  capitalDeployed: number;
  capitalLimit: number;
  killSwitchActive: boolean;
}

/** Daily performance data shape. */
export interface DailyPerformanceData {
  date: Date;
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  maxDrawdown: number;
  capitalDeployed: number;
}
