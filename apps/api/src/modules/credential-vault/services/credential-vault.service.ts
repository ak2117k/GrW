import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { KMS_PROVIDER, KmsProvider } from '../../../common/crypto/kms/kms-provider.interface';
import { AngelOneValidator } from '../../market-data/services/angel-one-validator.service';
import { encryptWithDataKey } from '../crypto/field-cipher';
import { maskClientId } from '../crypto/mask';
import { ConnectAngelOneDto } from '../dto/connect-angel-one.dto';

/** Non-secret request metadata threaded into audit rows (ip, etc.). */
export interface ReqMeta {
  ip?: string;
  [k: string]: unknown;
}

export interface ConnectResult {
  connected: true;
  validatedAt: Date;
}

/** The account now powering the shared market-data feed (design §3.5). */
export interface FeedAccountResult {
  userId: string;
  email: string;
}

/** Non-secret status surface — decrypts NOTHING (TDA-005 §4.1). */
export interface BrokerStatus {
  connected: boolean;
  broker?: string;
  isActive?: boolean;
  keyVersion?: string;
  clientIdMasked?: string | null;
  lastConnected?: Date | null;
  lastValidated?: Date | null;
}

/**
 * The write side of the per-tenant credential vault (TDA-005 §4): connect /
 * disconnect / status / re-wrap. Owns everything EXCEPT decrypt-for-execution
 * (that is the isolated CredentialDecryptor, §6). Injects the KMS provider for
 * `generateDataKey` / `wrapKey` ONLY — it never calls `unwrapKey`.
 *
 * NO plaintext secret or DEK is ever persisted or logged; the DEK is zeroized in
 * a `finally`, and audit `meta` carries only a masked client-id + request meta.
 */
@Injectable()
export class CredentialVaultService {
  private readonly logger = new Logger(CredentialVaultService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(KMS_PROVIDER) private readonly kms: KmsProvider,
    private readonly audit: AuditService,
    private readonly validator: AngelOneValidator,
  ) {}

  /**
   * Validate the submitted creds via a real ephemeral login, then (only on
   * success) envelope-encrypt and upsert them for `userId`. A failed login
   * persists NOTHING and throws 422.
   */
  async connect(
    userId: string,
    dto: ConnectAngelOneDto,
    reqMeta: ReqMeta,
  ): Promise<ConnectResult> {
    // 1. VALIDATE FIRST — nothing persisted yet.
    const ok = await this.validator.validateLogin({
      apiKey: dto.apiKey,
      clientId: dto.clientId,
      password: dto.password,
      totpSecret: dto.totpSecret,
    });
    if (!ok.success) {
      throw new UnprocessableEntityException('Angel One login failed');
    }

    // 2. ENVELOPE-ENCRYPT.
    const dk = await this.kms.generateDataKey();
    const validatedAt = new Date();
    try {
      const enc = {
        encApiKey: encryptWithDataKey(dto.apiKey, dk.plaintext),
        encApiSecret: encryptWithDataKey(dto.apiSecret, dk.plaintext),
        encClientId: encryptWithDataKey(dto.clientId, dk.plaintext),
        encPassword: encryptWithDataKey(dto.password, dk.plaintext),
        encTotpSecret: encryptWithDataKey(dto.totpSecret, dk.plaintext),
      };
      const clientIdMasked = maskClientId(dto.clientId);
      await this.prisma.brokerCredential.upsert({
        where: { userId },
        create: {
          userId,
          broker: 'angel_one',
          ...enc,
          encDataKey: dk.wrapped,
          keyVersion: dk.keyVersion,
          clientIdMasked,
          isActive: true,
          lastValidated: validatedAt,
          lastConnected: validatedAt,
        },
        update: {
          ...enc,
          encDataKey: dk.wrapped,
          keyVersion: dk.keyVersion,
          clientIdMasked,
          isActive: true,
          lastValidated: validatedAt,
          lastConnected: validatedAt,
        },
      });
    } finally {
      dk.plaintext.fill(0); // zeroize the DEK
    }

    // 3. AUDIT — metadata only, NO secrets.
    await this.audit.append({
      action: 'CREDENTIAL_CONNECT',
      userId,
      target: 'angel_one',
      meta: { clientIdMasked: maskClientId(dto.clientId), ...reqMeta },
    });

    return { connected: true, validatedAt };
  }

  /** Delete the tenant's credential row and emit CREDENTIAL_DELETE. */
  async disconnect(userId: string, reqMeta: ReqMeta): Promise<void> {
    await this.prisma.brokerCredential.deleteMany({ where: { userId } });
    await this.audit.append({
      action: 'CREDENTIAL_DELETE',
      userId,
      target: 'angel_one',
      meta: { ...reqMeta },
    });
  }

  /**
   * ADMIN-only: designate `userId` as the single account whose vault credentials
   * power the shared market-data feed (design §3.5). Runs in ONE transaction:
   *   1. the target user must exist (404) and have a BrokerCredential (400);
   *   2. clear any current feed account (isFeedAccount=true → false);
   *   3. flag the target.
   * The clear-then-set order keeps the partial unique index
   * (`WHERE "isFeedAccount" = true`) satisfied at commit. Returns the new feed
   * account's id + email — NO secret fields are read or returned.
   */
  async setFeedAccount(userId: string): Promise<FeedAccountResult> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, brokerCredential: { select: { id: true } } },
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      if (!user.brokerCredential) {
        throw new BadRequestException('User has no connected broker account');
      }

      // Clear the prior feed account BEFORE setting the new one, so the partial
      // unique index never sees two `isFeedAccount = true` rows.
      await tx.user.updateMany({
        where: { isFeedAccount: true },
        data: { isFeedAccount: false },
      });
      await tx.user.update({
        where: { id: userId },
        data: { isFeedAccount: true },
      });

      return { userId: user.id, email: user.email };
    });
  }

  /** Non-secret status; performs ZERO KMS calls and decrypts nothing. */
  async getStatus(userId: string): Promise<BrokerStatus> {
    const row = await this.prisma.brokerCredential.findUnique({ where: { userId } });
    if (!row) return { connected: false };
    return {
      connected: true,
      broker: row.broker,
      isActive: row.isActive,
      keyVersion: row.keyVersion,
      clientIdMasked: row.clientIdMasked,
      lastConnected: row.lastConnected,
      lastValidated: row.lastValidated,
    };
  }
}
