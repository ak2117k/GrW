import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { AuditService, type AuditAction } from '../../../common/audit';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { LoginDto, SignupDto } from '../dto';
import { EmailService } from './email/email.service';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import {
  RefreshReuseError,
  TokenContext,
  TokenPair,
  TokenService,
} from './token.service';

/** Email-verification token lifetime: 24h. */
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** Password-reset token lifetime: 1h (short by design). */
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Generic, non-enumerating forgot-password response. Returned with the same
 * status + body whether or not the email belongs to a registered user.
 */
const FORGOT_PASSWORD_MESSAGE =
  'If that email address is registered, a password reset link has been sent.';

/** Lifetime of the short-lived JWT issued for the login MFA challenge. */
const MFA_TOKEN_TTL = '5m';

/** Purpose claim that scopes the MFA-challenge JWT to `/auth/login/mfa` only. */
const MFA_TOKEN_PURPOSE = 'mfa';

/**
 * The one signing algorithm the MFA-challenge token is minted with and the only
 * one accepted when verifying it. Pinned on BOTH sign and verify so the token
 * can never be re-interpreted under a different algorithm (substitution attack).
 */
const JWT_ALGORITHM = 'HS256';

/**
 * Audience claim isolating the MFA-challenge token from session access tokens
 * (which use `td-access`). The global guard's JWT strategy requires `td-access`,
 * so this token can never be replayed as a Bearer access token — and `loginMfa`
 * only accepts a token bearing THIS audience.
 */
const MFA_TOKEN_AUDIENCE = 'td-mfa';

/**
 * Returned by {@link AuthService.login} when the account has MFA enabled: the
 * caller must complete the challenge at `/auth/login/mfa` with `mfaToken` plus a
 * current TOTP code. No session tokens are issued until the code is verified.
 */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

/** Either a full session (password OK, no MFA) or an MFA challenge. */
export type LoginResult = TokenPair | MfaChallenge;

/** Claims carried by the short-lived MFA-challenge token. */
interface MfaTokenClaims {
  sub: string;
  purpose: string;
}

/**
 * A real argon2id PHC hash (of a throw-away string) used to equalise login
 * timing when the email is unknown: we still run a full argon2 verify against
 * this dummy so an absent user costs the same ~argon2 time as a wrong password
 * on a real user — closing the timing side-channel that would otherwise enable
 * email enumeration (spec §6, timing-safe login). It must stay a VALID PHC
 * string (matching the PasswordService params) so verify actually does the work
 * rather than throwing fast on a malformed hash.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$rwpHfefAFUyWtitQq3/WEw$Dxq0dTpzMvMGkdx1SGadAIj43x8/JFdEx02Diz2PIqE';

/**
 * Generic, non-enumerating signup response. The same message is returned whether
 * or not the email was already registered.
 */
const SIGNUP_MESSAGE =
  'If that email address is available, a verification link has been sent.';

/**
 * Generic, non-enumerating resend-verification response. Returned unchanged
 * whether the email is unknown, already verified, or a pending account that was
 * actually re-sent a link.
 */
const RESEND_VERIFICATION_MESSAGE =
  'If that email address needs verifying, a new verification link has been sent.';

interface SignupResult {
  message: string;
  /** Test-only seam (NODE_ENV=test): the raw email-verification token. */
  verificationToken?: string;
}

interface ForgotPasswordResult {
  message: string;
  /**
   * Test-only seam (NODE_ENV=test, real user only): the raw PASSWORD_RESET
   * token. Production never returns it — it is delivered solely by email.
   */
  resetToken?: string;
}

/**
 * Orchestrates the auth core flows: signup + email verification, password login,
 * refresh-token rotation, logout, and the `/me` profile. Token mechanics live in
 * {@link TokenService}; password hashing in {@link PasswordService}; delivery in
 * {@link EmailService}. Every flow writes an `AuditLog` row via
 * {@link AuditService.append} (TDA-008), which hash-chains each row; the write
 * is best-effort (swallowed) so an audit hiccup never breaks the auth flow.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly email: EmailService,
    private readonly mfa: MfaService,
    private readonly jwt: JwtService,
    private readonly audits: AuditService,
  ) {}

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async audit(
    action: string,
    userId: string | null,
    target?: string | null,
    meta?: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.audits.append({
        action: action as AuditAction,
        userId: userId ?? null,
        target: target ?? null,
        meta: meta as Record<string, unknown> | undefined,
      });
    } catch (err) {
      // Auditing must never break the user-facing flow.
      this.logger.error(`Failed to write audit row ${action}`, err as Error);
    }
  }

  private verifyUrl(rawToken: string): string {
    const base = process.env.APP_BASE_URL ?? 'http://localhost:4000';
    return `${base.replace(/\/$/, '')}/verify-email?token=${rawToken}`;
  }

  private resetUrl(rawToken: string): string {
    const base = process.env.APP_BASE_URL ?? 'http://localhost:4000';
    return `${base.replace(/\/$/, '')}/reset-password?token=${rawToken}`;
  }

  /**
   * Create a PENDING_VERIFICATION user, issue an email-verification token (only
   * the sha256 is stored), and email the opaque token as a link. Always returns
   * the same generic message — no user enumeration. If the email is already
   * registered, no second account/email is created.
   */
  async signup(dto: SignupDto): Promise<SignupResult> {
    // Reject weak passwords BEFORE any user lookup so the outcome never depends
    // on whether the email exists (no enumeration).
    this.passwords.assertStrength(dto.password);

    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      return { message: SIGNUP_MESSAGE };
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: dto.displayName ?? null,
        role: 'USER',
        status: 'PENDING_VERIFICATION',
      },
    });

    const rawToken = randomBytes(32).toString('base64url');
    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        type: 'EMAIL_VERIFY',
        tokenHash: this.sha256(rawToken),
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
      },
    });

    await this.email.sendVerification(email, this.verifyUrl(rawToken));
    await this.audit('AUTH_SIGNUP', user.id, email);

    const result: SignupResult = { message: SIGNUP_MESSAGE };
    if (process.env.NODE_ENV === 'test') {
      result.verificationToken = rawToken;
    }
    return result;
  }

  /**
   * Re-send the email-verification link. ALWAYS returns the same generic message
   * regardless of whether the email is registered or already verified (no user
   * enumeration). A fresh EMAIL_VERIFY token is minted + emailed ONLY for a real,
   * still-PENDING_VERIFICATION user; every other case is a silent no-op. Previous
   * unused tokens are left intact (each remains valid until it expires), so a race
   * between a stale and a fresh link cannot lock the user out.
   */
  async resendVerification(rawEmail: string): Promise<SignupResult> {
    const email = rawEmail.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });
    const result: SignupResult = { message: RESEND_VERIFICATION_MESSAGE };

    // Only a genuinely-unverified account gets a new link. An ACTIVE/verified or
    // absent account yields the identical response with nothing sent.
    if (!user || user.status !== 'PENDING_VERIFICATION' || user.emailVerifiedAt) {
      return result;
    }

    const rawToken = randomBytes(32).toString('base64url');
    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        type: 'EMAIL_VERIFY',
        tokenHash: this.sha256(rawToken),
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
      },
    });

    await this.email.sendVerification(email, this.verifyUrl(rawToken));
    await this.audit('AUTH_EMAIL_VERIFY_RESENT', user.id, email);

    if (process.env.NODE_ENV === 'test') {
      result.verificationToken = rawToken;
    }
    return result;
  }

  /**
   * Validate an unexpired, unused EMAIL_VERIFY token: mark `emailVerifiedAt`,
   * flip status to ACTIVE, and consume the token.
   */
  async verifyEmail(token: string): Promise<{ message: string }> {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: this.sha256(token) },
    });
    if (
      !record ||
      record.type !== 'EMAIL_VERIFY' ||
      record.usedAt ||
      record.expiresAt.getTime() < Date.now()
    ) {
      throw new UnauthorizedException('Invalid or expired verification token');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
      }),
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return { message: 'Email verified. You can now sign in.' };
  }

  /**
   * Begin a password reset. ALWAYS returns the same generic message regardless
   * of whether the email is registered (no user enumeration). When the user
   * exists, mint a PASSWORD_RESET token (only the sha256 is persisted) and email
   * the opaque token as a link. Auditing/email happen only for a real user; the
   * outward response is identical either way.
   */
  async forgotPassword(rawEmail: string): Promise<ForgotPasswordResult> {
    const email = rawEmail.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });
    const result: ForgotPasswordResult = { message: FORGOT_PASSWORD_MESSAGE };
    if (!user) {
      return result;
    }

    const rawToken = randomBytes(32).toString('base64url');
    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        type: 'PASSWORD_RESET',
        tokenHash: this.sha256(rawToken),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    await this.email.sendPasswordReset(email, this.resetUrl(rawToken));
    await this.audit('AUTH_PASSWORD_FORGOT', user.id, email);

    if (process.env.NODE_ENV === 'test') {
      result.resetToken = rawToken;
    }
    return result;
  }

  /**
   * Complete a password reset. Validate an unexpired, unused PASSWORD_RESET
   * token, set a fresh argon2 hash, consume the token, and **revoke every live
   * refresh token** for the user so all existing sessions die.
   */
  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: this.sha256(token) },
    });
    if (
      !record ||
      record.type !== 'PASSWORD_RESET' ||
      record.usedAt ||
      record.expiresAt.getTime() < Date.now()
    ) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    this.passwords.assertStrength(newPassword);
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      }),
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.audit('AUTH_PASSWORD_RESET', record.userId, null);
    return { message: 'Password updated. Please sign in with your new password.' };
  }

  /**
   * Password login. Generic failure (no "wrong password" vs "no user"
   * distinction). Requires an ACTIVE, email-verified account. When the account
   * has MFA enabled, a correct password yields an {@link MfaChallenge} (a
   * short-lived `mfaToken`) instead of session tokens — the caller must finish
   * at `/auth/login/mfa`.
   */
  async login(dto: LoginDto, ctx: TokenContext): Promise<LoginResult> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Always run a full argon2 verify — against the real hash, or a dummy when
    // the user is absent — so both branches cost the same time (no enumeration).
    const passwordOk = await this.passwords.verify(
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
      dto.password,
    );
    if (!user || !passwordOk) {
      await this.audit('AUTH_LOGIN_FAILED', user?.id ?? null, email);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      await this.audit('AUTH_LOGIN_FAILED', user.id, email, {
        reason: 'inactive_or_unverified',
      });
      throw new UnauthorizedException('Account is not active or not verified');
    }

    // MFA gate: a correct password is necessary but not sufficient. Issue a
    // short-lived, purpose-scoped JWT and defer session tokens until the TOTP
    // code is verified at /auth/login/mfa.
    if (user.mfaEnabled) {
      const claims: MfaTokenClaims = {
        sub: user.id,
        purpose: MFA_TOKEN_PURPOSE,
      };
      const mfaToken = this.jwt.sign(claims, {
        secret: process.env.JWT_SECRET,
        expiresIn: MFA_TOKEN_TTL,
        algorithm: JWT_ALGORITHM,
        audience: MFA_TOKEN_AUDIENCE,
      });
      await this.audit('AUTH_MFA_CHALLENGE', user.id, email);
      return { mfaRequired: true, mfaToken };
    }

    return this.issueSession(user, email, ctx);
  }

  /**
   * Complete the login MFA challenge: validate the short-lived `mfaToken`
   * (purpose-scoped), verify the TOTP `code`, then issue the real session pair.
   */
  async loginMfa(
    mfaToken: string,
    code: string,
    ctx: TokenContext,
  ): Promise<TokenPair> {
    let claims: MfaTokenClaims;
    try {
      claims = this.jwt.verify<MfaTokenClaims>(mfaToken, {
        secret: process.env.JWT_SECRET,
        // Pin the accepted signing algorithm: the MFA-challenge token is
        // HS256-signed with JWT_SECRET, so accepting only HS256 closes the
        // algorithm-substitution surface (e.g. a forged `alg:none`/asymmetric
        // token). Mirrors TokenService.verifyAccess and the WS admin verifier.
        algorithms: [JWT_ALGORITHM],
        audience: MFA_TOKEN_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA token');
    }
    if (claims.purpose !== MFA_TOKEN_PURPOSE || !claims.sub) {
      throw new UnauthorizedException('Invalid MFA token');
    }

    const codeOk = await this.mfa.verify(claims.sub, code);
    if (!codeOk) {
      await this.audit('AUTH_MFA_FAILED', claims.sub, null, { stage: 'login' });
      throw new UnauthorizedException('Invalid MFA code');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }
    return this.issueSession(user, user.email, ctx);
  }

  /** Mint the access+refresh pair, stamp `lastLoginAt`, and audit AUTH_LOGIN. */
  private async issueSession(
    user: { id: string; role: string; email: string },
    email: string,
    ctx: TokenContext,
  ): Promise<TokenPair> {
    const pair = await this.tokens.issuePair(
      { id: user.id, role: user.role, email: user.email },
      ctx,
    );
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit('AUTH_LOGIN', user.id, email);
    return pair;
  }

  /**
   * Rotate a refresh token. Reuse of an already-rotated token is detected by
   * {@link TokenService.rotate} (revokes the whole family); we surface that as an
   * `AUTH_REFRESH_REUSE` audit event and a 401.
   */
  async refresh(refreshToken: string, ctx: TokenContext): Promise<TokenPair> {
    try {
      const pair = await this.tokens.rotate(refreshToken, ctx);
      const userId = this.safeUserIdFromAccess(pair.accessToken);
      await this.audit('AUTH_REFRESH', userId, null);
      return pair;
    } catch (err) {
      if (err instanceof RefreshReuseError) {
        // The presented (now-revoked) token row still exists; recover its owner
        // so the theft event is attributable.
        const row = await this.prisma.refreshToken.findUnique({
          where: { tokenHash: this.sha256(refreshToken) },
          select: { userId: true },
        });
        await this.audit('AUTH_REFRESH_REUSE', row?.userId ?? null, null);
      }
      throw err;
    }
  }

  private safeUserIdFromAccess(accessToken: string): string | null {
    try {
      return this.tokens.verifyAccess(accessToken).sub;
    } catch {
      return null;
    }
  }

  /** Revoke all of the caller's live refresh tokens (logout everywhere). */
  async logout(userId: string): Promise<{ message: string }> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit('AUTH_LOGOUT', userId, null);
    return { message: 'Logged out.' };
  }

  /** Current-user profile for `/auth/me`. */
  async me(userId: string): Promise<{
    id: string;
    email: string;
    role: string;
    status: string;
    mfaEnabled: boolean;
  }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
    };
  }
}
