import {
  IsOptional,
  IsString,
  IsNumber,
  IsBoolean,
  IsEnum,
  IsDateString,
  Min,
  Max,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SignalFilterDto {
  @IsOptional()
  @IsString()
  strategy?: string;

  @IsOptional()
  @IsString()
  segment?: string;

  @IsOptional()
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'])
  confidence?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  minScore?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class CreateSignalDto {
  @IsString()
  instrumentId: string;

  @IsIn(['BUY', 'SELL'])
  side: string;

  @IsNumber()
  entryPrice: number;

  @IsNumber()
  targetPrice: number;

  @IsNumber()
  stoplossPrice: number;

  @IsString()
  strategy: string;

  @IsString()
  timeframe: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  confidenceScore?: number;

  @IsOptional()
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'])
  confidence?: string;
}
