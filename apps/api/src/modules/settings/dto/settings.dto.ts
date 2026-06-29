import {
  IsOptional,
  IsBoolean,
  IsNumber,
  IsString,
  IsArray,
  IsEnum,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum AutoTradeModeEnum {
  OFF = 'OFF',
  APPROVAL_REQUIRED = 'APPROVAL_REQUIRED',
  FULLY_AUTOMATIC = 'FULLY_AUTOMATIC',
  PAPER_TRADING = 'PAPER_TRADING',
}

export class UpdateSettingsDto {
  @ApiPropertyOptional({ enum: AutoTradeModeEnum })
  @IsOptional()
  @IsEnum(AutoTradeModeEnum, {
    message:
      'autoTradeMode must be one of: OFF, APPROVAL_REQUIRED, FULLY_AUTOMATIC, PAPER_TRADING',
  })
  autoTradeMode?: AutoTradeModeEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  paperTrading?: boolean;

  @ApiPropertyOptional({ minimum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(100, { message: 'maxDailyLoss must be at least 100' })
  maxDailyLoss?: number;

  @ApiPropertyOptional({ minimum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(100, { message: 'maxCapitalPerTrade must be at least 100' })
  maxCapitalPerTrade?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'maxConcurrentPositions must be at least 1' })
  @Max(20, { message: 'maxConcurrentPositions must be at most 20' })
  maxConcurrentPositions?: number;

  @ApiPropertyOptional({ minimum: 0.5, maximum: 10 })
  @IsOptional()
  @IsNumber()
  @Min(0.5, { message: 'defaultRiskReward must be at least 0.5' })
  @Max(10, { message: 'defaultRiskReward must be at most 10' })
  defaultRiskReward?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  activeStrategies?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  preferredSegments?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  tradingHoursOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notificationsEnabled?: boolean;
}
