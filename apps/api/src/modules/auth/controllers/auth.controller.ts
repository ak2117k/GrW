import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentUser, Public } from '../../../common/decorators';
import type { AuthenticatedUser } from '../../../common/decorators';
import { AccountRateLimit } from '../../../common/ratelimit/account-rate-limit.decorator';
import { AccountRateLimitGuard } from '../../../common/ratelimit/account-rate-limit.guard';
import {
  ForgotPasswordDto,
  LoginDto,
  LoginMfaDto,
  MfaCodeDto,
  MfaDisableDto,
  RefreshDto,
  ResetPasswordDto,
  SignupDto,
  VerifyEmailDto,
} from '../dto';
import { AuthService } from '../services/auth.service';
import { MfaService } from '../services/mfa.service';
import { TokenContext } from '../services/token.service';

/**
 * Brute-force defence for the sensitive auth routes (spec §7): 10 requests per
 * 60s window, keyed per-IP by the {@link ThrottlerGuard}. Applied per-handler
 * (login, login/mfa, password/forgot) so the global `JwtAuthGuard` still governs
 * the protected routes unchanged. Exceeding the window yields HTTP 429.
 */
const AUTH_THROTTLE = { limit: 10, ttl: 60_000 };

/**
 * Per-ACCOUNT brute-force ceiling (TDA-004 Task 7): 5 attempts per 15-minute
 * window, keyed on the normalised request email by the {@link AccountRateLimitGuard}
 * — independent of source IP, so credential stuffing one account from many IPs
 * is still blocked. Returns an identical 429 whether or not the account exists
 * (no enumeration). Runs ALONGSIDE the per-IP `ThrottlerGuard`.
 */
const ACCOUNT_THROTTLE = { limit: 5, ttl: 15 * 60_000 };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  private ctx(req: Request): TokenContext {
    return {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    };
  }

  @Public()
  @Post('signup')
  @ApiOperation({ summary: 'Register a new user and send a verification email' })
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify an email address and activate the account' })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @Public()
  @Throttle({ default: AUTH_THROTTLE })
  @AccountRateLimit(ACCOUNT_THROTTLE)
  @UseGuards(ThrottlerGuard, AccountRateLimitGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate and receive an access + refresh pair' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, this.ctx(req));
  }

  @Public()
  @Throttle({ default: AUTH_THROTTLE })
  @UseGuards(ThrottlerGuard)
  @Post('login/mfa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete the login MFA challenge and receive tokens' })
  loginMfa(@Body() dto: LoginMfaDto, @Req() req: Request) {
    return this.auth.loginMfa(dto.mfaToken, dto.code, this.ctx(req));
  }

  @Public()
  @Throttle({ default: AUTH_THROTTLE })
  @AccountRateLimit(ACCOUNT_THROTTLE)
  @UseGuards(ThrottlerGuard, AccountRateLimitGuard)
  @Post('password/forgot')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password-reset link (always 200; no enumeration)' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset the password and revoke all refresh tokens' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token for a new pair' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, this.ctx(req));
  }

  @ApiBearerAuth()
  @Post('mfa/enroll')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start TOTP enrolment (returns otpauth URI + secret)' })
  mfaEnroll(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.enroll(user.userId);
  }

  @ApiBearerAuth()
  @Post('mfa/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a code to activate MFA' })
  async mfaActivate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaCodeDto,
  ) {
    await this.mfa.activate(user.userId, dto.code);
    return { message: 'MFA enabled.' };
  }

  @ApiBearerAuth()
  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a code to disable MFA' })
  async mfaDisable(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaDisableDto,
  ) {
    await this.mfa.disable(user.userId, dto.password, dto.code);
    return { message: 'MFA disabled.' };
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the caller refresh tokens' })
  logout(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.logout(user.userId);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Current user profile' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.userId);
  }
}
