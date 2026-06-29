import {
  IsOptional,
  IsString,
  IsEnum,
  IsDateString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export enum NewsCategory {
  INDIAN = 'indian',
  GLOBAL = 'global',
  SECTOR = 'sector',
  COMPANY = 'company',
}

export enum NewsSentiment {
  BULLISH = 'bullish',
  BEARISH = 'bearish',
  NEUTRAL = 'neutral',
}

export class NewsFilterDto {
  @ApiPropertyOptional({ enum: NewsCategory })
  @IsOptional()
  @IsEnum(NewsCategory, {
    message: 'category must be one of: indian, global, sector, company',
  })
  category?: NewsCategory;

  @ApiPropertyOptional({ enum: NewsSentiment })
  @IsOptional()
  @IsEnum(NewsSentiment, {
    message: 'sentiment must be one of: bullish, bearish, neutral',
  })
  sentiment?: NewsSentiment;

  @ApiPropertyOptional({ description: 'Filter by news source' })
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional({ description: 'Search text in title/summary' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Start date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'End date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
