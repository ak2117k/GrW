import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Query params for GET /api/strategy-review. Both bounds are optional
 * YYYY-MM-DD calendar dates; omitting them returns all stored history.
 */
export class StrategyReviewQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}
