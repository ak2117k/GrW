import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { generateSecret, generateURI, verify } from 'otplib';
import {
  decryptField,
  encryptField,
} from '../../../common/crypto/field-crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PasswordService } from './password.service';

/** Issuer label shown in authenticator apps (otpauth URI). */
const TOTP_ISSUER = 'TD Automation';

/**
 * TOTP verification tolerance, in SECONDS. otplib v13's functional API expresses
 * the verification window as an epoch tolerance rather than a step count; with
 * the default 30s period this ±30s window is equivalent to the classic ±1 step,
 * absorbing clock skew between the server and the user's authenticator app.
 */
const TOTP_TOLERANCE_SECONDS = 30;

/**
 * Result returned by {@link MfaService.enroll}. The raw base32 `secret` is
 * disclosed exactly ONCE (so the client can render/scan a QR) and is never
 * returned again after activation — only its encrypted form is persisted.
 */
export interface MfaEnrollment {
  otpauthUri: string;
  secret: string;
}

/**
 * Optional per-user TOTP MFA (TDA-002 Task 5).
 *
 * Lifecycle: {@link enroll} persists a PENDING (encrypted) secret with
 * `mfaEnabled=false`; {@link activate} verifies a code from the authenticator
 * and flips `mfaEnabled=true`; {@link verify} backs the login challenge; and
 * {@link disable} verifies a current code before wiping the secret.
 *
 * Security: the TOTP secret is sensitive and is stored ONLY AES-256-GCM
 * encrypted (interim `field-crypto`, KMS in TDA-005). It is returned in the
 * clear solely by `enroll`, never afterwards. otplib here is v13 — its
 * functional API (`generate`/`verify`) is async.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  private async audit(
    action: string,
    userId: string | null,
    meta?: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          userId: userId ?? undefined,
          meta: meta ?? undefined,
          hash: '',
          prevHash: '',
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write audit row ${action}`, err as Error);
    }
  }

  /** Decrypt the stored secret and check a TOTP code against it. */
  private async checkCode(secret: string, code: string): Promise<boolean> {
    const result = await verify({
      secret,
      token: code,
      epochTolerance: TOTP_TOLERANCE_SECONDS,
    });
    return result.valid;
  }

  /**
   * Begin TOTP enrolment: generate a fresh base32 secret, persist it ENCRYPTED
   * as a pending value (leaving `mfaEnabled=false`), and return the raw secret +
   * otpauth URI for the client to scan ONCE.
   *
   * If MFA is ALREADY enabled, enrolment is REFUSED (409): otherwise a
   * password-only attacker (or a stray re-enroll) could overwrite the active
   * secret and reset `mfaEnabled=false`, silently disabling the victim's second
   * factor. The user must `disable` (password + code) before re-enrolling.
   */
  async enroll(userId: string): Promise<MfaEnrollment> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    if (user.mfaEnabled) {
      throw new ConflictException('MFA already enabled; disable it first');
    }

    const secret = generateSecret();
    const otpauthUri = generateURI({
      issuer: TOTP_ISSUER,
      label: user.email,
      secret,
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecretEnc: encryptField(secret), mfaEnabled: false },
    });
    await this.audit('AUTH_MFA_ENROLL', userId);

    return { otpauthUri, secret };
  }

  /**
   * Activate MFA: verify `code` against the pending (encrypted) secret and, on
   * success, flip `mfaEnabled=true`. Throws on a missing enrolment or bad code.
   */
  async activate(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mfaSecretEnc) {
      throw new BadRequestException('No pending MFA enrolment');
    }

    const ok = await this.checkCode(decryptField(user.mfaSecretEnc), code);
    if (!ok) {
      await this.audit('AUTH_MFA_FAILED', userId, { stage: 'activate' });
      throw new UnauthorizedException('Invalid MFA code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true },
    });
    await this.audit('AUTH_MFA_ACTIVATE', userId);
  }

  /**
   * Verify a TOTP code for an MFA-enabled user (backs the login challenge).
   * Returns false (rather than throwing) when MFA isn't set up so callers can
   * map it to a generic auth failure.
   */
  async verify(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mfaEnabled || !user.mfaSecretEnc) {
      return false;
    }
    return this.checkCode(decryptField(user.mfaSecretEnc), code);
  }

  /**
   * Disable MFA: require BOTH the account password AND a current valid TOTP code
   * (spec §5) before clearing `mfaEnabled` and wiping the stored secret. Throws
   * on a missing enrolment, wrong password, or bad code.
   */
  async disable(userId: string, password: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mfaSecretEnc) {
      throw new BadRequestException('MFA is not enabled');
    }

    const passwordOk = await this.passwords.verify(user.passwordHash, password);
    const codeOk = await this.checkCode(decryptField(user.mfaSecretEnc), code);
    if (!passwordOk || !codeOk) {
      await this.audit('AUTH_MFA_FAILED', userId, { stage: 'disable' });
      throw new UnauthorizedException('Invalid password or MFA code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecretEnc: null },
    });
    await this.audit('AUTH_MFA_DISABLE', userId);
  }
}
