import type { CoreStrategy, CoreStrategySelection, CoreStrategyVersion } from '@prisma/client';
import { IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { VERSION_STATUSES, type VersionCreator, type VersionStatus } from '../version-status';

/**
 * Request bodies. None carries createdBy, status (except SetVersionStatusDto) or
 * userId: the global ValidationPipe({ whitelist: true }) strips anything else.
 * `blocks` is checked by validateBlocks in the service (plan decision 2).
 */
export class CreateDraftDto {
  @IsObject()
  blocks!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class EditVersionDto {
  @IsOptional()
  @IsObject()
  blocks?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class SetVersionStatusDto {
  @IsIn([...VERSION_STATUSES])
  status!: VersionStatus;
}

export class SetSelectionDto {
  @IsString()
  @MaxLength(64)
  strategyVersionId!: string;

  @IsBoolean()
  enabled!: boolean;

  /** Rupees. Capped against funds by the Risk Wall (M2/M3), not here. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  capitalAllocation!: number;
}

/** Wire shapes. Dates are ISO strings; nullable columns are `null`, never undefined. */
export interface CoreStrategyVersionDto {
  id: string;
  strategyId: string;
  version: number;
  status: VersionStatus;
  blocks: unknown;
  createdBy: VersionCreator;
  approvedBy: string | null;
  approvedAt: string | null;
  sourceDocId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CoreStrategyDto {
  id: string;
  key: string;
  name: string;
  description: string;
  allowedVehicles: string[];
  createdAt: string;
  versions: CoreStrategyVersionDto[];
}

export interface CoreSelectionDto {
  id: string;
  strategyId: string;
  strategyVersionId: string;
  enabled: boolean;
  capitalAllocation: number;
  updatedAt: string;
}

export function toVersionDto(v: CoreStrategyVersion): CoreStrategyVersionDto {
  return {
    id: v.id,
    strategyId: v.strategyId,
    version: v.version,
    status: v.status as VersionStatus,
    blocks: v.blocks,
    createdBy: v.createdBy as VersionCreator,
    approvedBy: v.approvedBy ?? null,
    approvedAt: v.approvedAt ? v.approvedAt.toISOString() : null,
    sourceDocId: v.sourceDocId ?? null,
    notes: v.notes ?? null,
    createdAt: v.createdAt.toISOString(),
  };
}

export function toStrategyDto(s: CoreStrategy & { versions: CoreStrategyVersion[] }): CoreStrategyDto {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    description: s.description,
    allowedVehicles: [...s.allowedVehicles],
    createdAt: s.createdAt.toISOString(),
    versions: s.versions.map(toVersionDto),
  };
}

export function toSelectionDto(s: CoreStrategySelection): CoreSelectionDto {
  return {
    id: s.id,
    strategyId: s.strategyId,
    strategyVersionId: s.strategyVersionId,
    enabled: s.enabled,
    capitalAllocation: s.capitalAllocation,
    updatedAt: s.updatedAt.toISOString(),
  };
}
