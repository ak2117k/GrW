import { IsBoolean, IsOptional, IsPositive, IsNumber } from 'class-validator';

/**
 * Body for `PATCH /api/me/auto-exec/:segment` (TDA-017). Every field is optional
 * — a PATCH mutates only the knobs it carries. `riskPerTrade` / `maxCapital` are
 * money/limit values so they must be strictly positive when present. The global
 * `ValidationPipe` runs with `whitelist: true`, so unknown keys are stripped.
 *
 * SAFETY: `enabled: true` is NOT sufficient on its own — the service still gates
 * it behind an accepted current risk disclosure. `killSwitch` is a safety
 * control and is intentionally never gated.
 */
export class UpdateAutoExecDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  killSwitch?: boolean;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  riskPerTrade?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  maxCapital?: number;
}
