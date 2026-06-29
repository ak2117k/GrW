import {
  IsString,
  IsOptional,
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  ValidateNested,
  Min,
  IsDate,
} from 'class-validator';
import { Type } from 'class-transformer';

// ── Indicator configuration (visual mode) ────────────────────────────

export const SUPPORTED_INDICATORS = [
  'RSI',
  'EMA',
  'SMA',
  'MACD',
  'VWAP',
  'BB',
  'ATR',
  'SUPERTREND',
  'ADX',
  'VOLUME',
  'OI',
] as const;

export type IndicatorType = (typeof SUPPORTED_INDICATORS)[number];

export const SUPPORTED_CONDITIONS = [
  'CROSSES_ABOVE',
  'CROSSES_BELOW',
  'GREATER_THAN',
  'LESS_THAN',
  'BETWEEN',
  'AND',
  'OR',
] as const;

export type ConditionType = (typeof SUPPORTED_CONDITIONS)[number];

export class IndicatorConfig {
  @IsString()
  @IsIn(SUPPORTED_INDICATORS as unknown as string[])
  type: IndicatorType;

  @IsOptional()
  @IsNumber()
  @Min(1)
  period?: number;

  @IsOptional()
  @IsObject()
  params?: Record<string, number>;
}

export class RuleOperand {
  @IsOptional()
  @IsString()
  indicator?: string;

  @IsOptional()
  @IsString()
  param?: string;

  @IsOptional()
  @IsNumber()
  value?: number;
}

export class RuleConfig {
  @IsString()
  @IsIn(SUPPORTED_CONDITIONS as unknown as string[])
  condition: ConditionType;

  @ValidateNested()
  @Type(() => RuleOperand)
  left: RuleOperand;

  @ValidateNested()
  @Type(() => RuleOperand)
  right: RuleOperand;
}

// ── Main user strategy DTO ───────────────────────────────────────────

export class UserStrategyDto {
  /** Auto-generated on save; ignored on create */
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Strategy source code (script mode) or empty (visual mode) */
  @IsOptional()
  @IsString()
  code?: string;

  @IsIn(['script', 'visual'])
  type: 'script' | 'visual';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IndicatorConfig)
  indicators?: IndicatorConfig[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RuleConfig)
  entryRules?: RuleConfig[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RuleConfig)
  exitRules?: RuleConfig[];

  @IsOptional()
  @IsObject()
  parameters?: Record<string, any>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  timeframes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  segments?: string[];

  @IsOptional()
  createdAt?: Date;

  @IsOptional()
  updatedAt?: Date;
}

// ── Validate-only DTO ────────────────────────────────────────────────

export class ValidateStrategyDto {
  @IsString()
  code: string;

  @IsIn(['script', 'visual'])
  type: 'script' | 'visual';
}

// ── Backtest config for user strategies ──────────────────────────────

export class UserStrategyBacktestDto {
  @IsString()
  symbol: string;

  @IsString()
  exchange: string;

  @IsString()
  timeframe: string;

  @Type(() => Date)
  @IsDate()
  startDate: Date;

  @Type(() => Date)
  @IsDate()
  endDate: Date;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  initialCapital?: number = 1_000_000;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  positionSize?: number = 1;
}
