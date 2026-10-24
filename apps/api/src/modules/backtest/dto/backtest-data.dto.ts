import { IsDate, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class AskBacktestAssistantDto {
  @IsString()
  @MaxLength(4000)
  prompt: string;
}

export class FetchBacktestDataDto {
  @IsString()
  @Matches(/^[A-Za-z0-9&-]{1,30}$/)
  symbol: string;

  @IsOptional()
  @IsIn(['NSE', 'BSE', 'NFO', 'MCX'])
  exchange?: string;

  @IsIn(['1m', '3m', '5m', '10m', '15m', '30m', '1h', '1d'])
  timeframe: string;

  @Type(() => Date)
  @IsDate()
  from: Date;

  @Type(() => Date)
  @IsDate()
  to: Date;
}
