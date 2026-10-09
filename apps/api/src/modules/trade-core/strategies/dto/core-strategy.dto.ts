import { Prisma, type CoreStrategy, type CoreStrategySelection, type CoreStrategyVersion } from '@prisma/client';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, ValidateBy } from 'class-validator';
import { VERSION_STATUSES, type VersionCreator, type VersionStatus } from '../version-status';

/**
 * Request bodies. None carries createdBy, status (except SetVersionStatusDto) or
 * userId: the global ValidationPipe({ whitelist: true }) strips anything else.
 * `blocks` is checked by validateBlocks in the service (plan decision 2).
 */
/** Exclusive upper bound for capital: DECIMAL(14,2) holds at most 999,999,999,999.99. */
export const CAPITAL_LIMIT = new Prisma.Decimal('1e12');

/**
 * The exact DECIMAL(14,2) value for a rupee amount sent as a JSON number, or null when
 * it cannot be stored as-is: not a finite number, negative, more than 2 decimal places,
 * or ≥ 10^12. Never rounds. A JS number is read through its shortest decimal form
 * (Prisma.Decimal(n)), so 1234.56 is exactly 1234.56 and 1e-7 has 7 places.
 */
export function toCapitalDecimal(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const d = new Prisma.Decimal(value);
  if (d.isNegative() || d.decimalPlaces() > 2 || d.gte(CAPITAL_LIMIT)) return null;
  return d;
}

/**
 * class-validator's own IsNumber({ maxDecimalPlaces }) throws a TypeError on numbers it
 * prints in exponent form (1e-7), which would surface as a 500; this one answers 400.
 */
function IsRupeeCapital(): PropertyDecorator {
  return ValidateBy({
    name: 'isRupeeCapital',
    validator: {
      validate: (value: unknown) => toCapitalDecimal(value) !== null,
      defaultMessage: () => '$property must be a number of rupees, 0 or more, with at most 2 decimal places and below 10^12',
    },
  });
}

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

  /**
   * Rupees as a JSON number: finite, ≥ 0, at most 2 decimal places, below 10^12, so it
   * fits DECIMAL(14,2) exactly (the service converts it with toCapitalDecimal). Capped
   * against funds by the Risk Wall (M2/M3), not here.
   */
  @IsRupeeCapital()
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
  /** Rupees, a JSON number with at most 2 decimal places (see toSelectionDto). */
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

/**
 * Serialisation decision (SP2 M1, binding): the column is DECIMAL(14,2) and the wire
 * carries capitalAllocation as a JSON NUMBER, `Number(d.toFixed(2))`. Every rupee amount
 * with 2 dp below 10^12 has fewer than 15 significant digits, so the double's shortest
 * form prints back the stored decimal exactly; the web type stays `number`. Exact
 * records (the audit meta, CoreStrategySelectionService snapshot) use the 2-dp string.
 */
export function toSelectionDto(s: CoreStrategySelection): CoreSelectionDto {
  return {
    id: s.id,
    strategyId: s.strategyId,
    strategyVersionId: s.strategyVersionId,
    enabled: s.enabled,
    capitalAllocation: Number(s.capitalAllocation.toFixed(2)),
    updatedAt: s.updatedAt.toISOString(),
  };
}
