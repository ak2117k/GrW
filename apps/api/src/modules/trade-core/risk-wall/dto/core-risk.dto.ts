import { IsBoolean, ValidateBy } from 'class-validator';

/**
 * Request bodies. Neither carries userId: the global ValidationPipe({ whitelist: true })
 * strips anything else, and the controller takes the user from the token. The value's
 * meaning depends on the limit, so the service parses it per key (parseLimitValue).
 * The bounds below are shapes, not risk values.
 */
export function isReason(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  // Measured as the services store it: they trim, so "   " or "  a " is no reason.
  const length = v.trim().length;
  return length >= 3 && length <= 500;
}

function IsReason(): PropertyDecorator {
  return ValidateBy({
    name: 'isReason',
    validator: { validate: (v: unknown) => isReason(v), defaultMessage: () => '$property must say why, in 3 to 500 characters' },
  });
}

function IsLimitValueShape(): PropertyDecorator {
  return ValidateBy({
    name: 'isLimitValueShape',
    validator: {
      validate: (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 32),
      defaultMessage: () => '$property must be a number or a short string (the limit decides which)',
    },
  });
}

export class ChangeLimitDto {
  @IsLimitValueShape()
  value!: number | string;

  @IsReason()
  reason!: string;
}

export class SetKillSwitchDto {
  @IsBoolean()
  active!: boolean;

  @IsReason()
  reason!: string;
}
