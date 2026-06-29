import {
  IsArray,
  IsString,
  IsOptional,
  IsEnum,
  IsDateString,
  ArrayMaxSize,
  ArrayMinSize,
} from 'class-validator';

export enum FeedMode {
  LTP = 'LTP',
  QUOTE = 'QUOTE',
  SNAP_QUOTE = 'SNAP_QUOTE',
}

export class SubscribeDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  tokens: string[];

  @IsOptional()
  @IsEnum(FeedMode)
  mode?: FeedMode = FeedMode.QUOTE;
}

export class UnsubscribeDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  tokens: string[];
}

export class HistoricalDataDto {
  @IsString()
  symbol: string;

  @IsString()
  exchange: string;

  @IsString()
  timeframe: string;

  @IsDateString()
  from: string;

  @IsDateString()
  to: string;
}

export class GetCandlesQueryDto {
  @IsString()
  timeframe: string;

  @IsDateString()
  from: string;

  @IsDateString()
  to: string;

  /**
   * Optional exchange override used when the instrument is not found in the
   * local database (e.g., MCX commodity tokens).  Defaults to "NSE".
   */
  @IsOptional()
  @IsString()
  exchange?: string;
}

export class SearchInstrumentDto {
  @IsString()
  query: string;

  @IsOptional()
  @IsString()
  exchange?: string;

  @IsOptional()
  @IsString()
  segment?: string;
}

export class GetOIQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
