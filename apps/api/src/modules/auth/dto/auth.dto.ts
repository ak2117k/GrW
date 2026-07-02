import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SignupDto {
  @ApiProperty({ example: 'trader@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(128, { message: 'password must be at most 128 characters' })
  password!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}

/** Request a fresh email-verification link for an address (non-enumerating). */
export class ResendVerificationDto {
  @ApiProperty({ example: 'trader@example.com' })
  @IsEmail()
  email!: string;
}

export class VerifyEmailDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  token!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'trader@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

/** Request a password-reset link for an email address (non-enumerating). */
export class ForgotPasswordDto {
  @ApiProperty({ example: 'trader@example.com' })
  @IsEmail()
  email!: string;
}

/** Complete a password reset: the emailed token + the new password. */
export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(128, { message: 'password must be at most 128 characters' })
  password!: string;
}

/** A 6-digit TOTP code (used by MFA activate). */
export class MfaCodeDto {
  @ApiProperty({ example: '123456', description: '6-digit TOTP code' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit string' })
  code!: string;
}

/** Disable MFA: requires BOTH the account password and a current TOTP code. */
export class MfaDisableDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiProperty({ example: '123456', description: '6-digit TOTP code' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit string' })
  code!: string;
}

/** Completes the login MFA challenge: the short-lived mfaToken + a TOTP code. */
export class LoginMfaDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  mfaToken!: string;

  @ApiProperty({ example: '123456', description: '6-digit TOTP code' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit string' })
  code!: string;
}
