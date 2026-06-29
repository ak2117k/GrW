import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class AskQuestionDto {
  @ApiProperty({ description: 'Question to ask the AI advisor' })
  @IsString()
  question: string;
}

export class AnalyzeTradeParamDto {
  @ApiProperty({ description: 'Trade ID to analyze' })
  @IsString()
  tradeId: string;
}

export class ReportIdParamDto {
  @ApiProperty({ description: 'Weekly report ID' })
  @IsString()
  id: string;
}

export class GetReportsDto {
  @ApiPropertyOptional({ description: 'Number of reports to fetch', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
