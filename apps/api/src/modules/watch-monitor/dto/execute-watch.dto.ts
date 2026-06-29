import { IsBoolean, IsEnum, IsInt, IsOptional, Min } from 'class-validator';

export class ExecuteWatchDto {
  @IsEnum(['paper', 'live'] as const)
  mode!: 'paper' | 'live';

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  /** Skip the upside gate — for manual force-execute when the gate is stale. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
