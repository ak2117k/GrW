import {
  IsOptional,
  IsString,
  IsInt,
  IsDateString,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class DateRangeDto {
  @ApiPropertyOptional({ description: 'Start date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'End date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export enum JournalSortBy {
  DATE = 'date',
  PNL = 'pnl',
  STRATEGY = 'strategy',
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export class JournalFilterDto extends DateRangeDto {
  @ApiPropertyOptional({ description: 'Filter by strategy name' })
  @IsOptional()
  @IsString()
  strategy?: string;

  @ApiPropertyOptional({ description: 'Filter by segment (OPTIONS, EQUITY, FUTURES, COMMODITY)' })
  @IsOptional()
  @IsString()
  segment?: string;

  @ApiPropertyOptional({ description: 'Filter by trade status' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by side (BUY, SELL)' })
  @IsOptional()
  @IsString()
  side?: string;

  // M5: filter by VIX regime captured at entry. The four real values come
  // from MarketContextService.classifyVixRegime; UNKNOWN is the fallback
  // when VIX wasn't reachable. We accept any string here rather than
  // an enum so older trades with null regime aren't blocked at the DTO layer.
  @ApiPropertyOptional({ description: 'Filter by VIX regime at entry (LOW|NORMAL|ELEVATED|HIGH|UNKNOWN)' })
  @IsOptional()
  @IsString()
  vixRegime?: string;

  // M5: filter by structured exit-reason tag persisted on closeTrade.
  @ApiPropertyOptional({ description: 'Filter by exit reason tag (HIT_TARGET|STOPPED_OUT|...)' })
  @IsOptional()
  @IsString()
  exitReasonTag?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based)', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: JournalSortBy })
  @IsOptional()
  @IsEnum(JournalSortBy)
  sortBy?: JournalSortBy = JournalSortBy.DATE;

  @ApiPropertyOptional({ enum: SortOrder })
  @IsOptional()
  @IsEnum(SortOrder)
  order?: SortOrder = SortOrder.DESC;
}

export class ChartTradesQueryDto {
  @ApiPropertyOptional({ description: 'Instrument token to fetch annotated trades for' })
  @IsString()
  token: string;
}

export class MonthlyReportDto {
  @ApiPropertyOptional({ description: 'Year (e.g. 2026)' })
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year: number;

  @ApiPropertyOptional({ description: 'Month (1-12)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;
}
