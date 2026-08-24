import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';

/**
 * One browser's account of a feed stall.
 *
 * `health` accepts only the two degraded states on purpose: a report saying
 * 'live' carries no information, and the recovery report deliberately carries
 * the state it recovered FROM plus `recoveredWithoutReload`.
 */
export class ClientFeedReportDto {
  @IsIn(['stale', 'offline'])
  health!: 'stale' | 'offline';

  @IsBoolean()
  tickSocketUp!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  secondsSinceLastTick?: number;

  @IsOptional()
  @IsString()
  transport?: string;

  @IsInt()
  @Min(0)
  subscribedTokens!: number;

  @IsObject()
  namespaces!: Record<string, boolean>;

  @IsOptional()
  @IsBoolean()
  recoveredWithoutReload?: boolean;
}
