import { IsOptional, IsString, Matches, MaxLength, ValidateBy } from 'class-validator';

/** YYYY-MM-DD naming a real calendar day (2026-13-45 and 2026-02-30 do not): a 400, never a 500 later. */
export function isCalendarDay(v: unknown): boolean {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function IsCalendarDay(): PropertyDecorator {
  return ValidateBy({ name: 'isCalendarDay', validator: { validate: isCalendarDay, defaultMessage: () => 'day must be a real YYYY-MM-DD date' } });
}

export class JournalDayQueryDto {
  /** IST date; today when absent. */
  @IsOptional()
  @IsCalendarDay()
  day?: string;
}

export class AckReconDto {
  @IsString()
  @MaxLength(500)
  @Matches(/\S/, { message: 'reason must say why' })
  reason!: string;
}
