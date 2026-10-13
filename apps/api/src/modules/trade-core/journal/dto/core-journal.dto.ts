import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class JournalDayQueryDto {
  /** IST date; today when absent. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be YYYY-MM-DD' })
  day?: string;
}

export class AckReconDto {
  @IsString()
  @MaxLength(500)
  @Matches(/\S/, { message: 'reason must say why' })
  reason!: string;
}
