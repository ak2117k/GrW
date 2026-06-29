import {
  IsString,
  IsNumber,
  IsDate,
  IsOptional,
  IsArray,
  ValidateNested,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RunBacktestDto {
  @IsString()
  strategy: string;

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
  initialCapital: number = 1000000;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  positionSize: number = 1;

  @IsOptional()
  parameters?: Record<string, any>;
}

export class CompareStrategiesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RunBacktestDto)
  configs: RunBacktestDto[];
}
