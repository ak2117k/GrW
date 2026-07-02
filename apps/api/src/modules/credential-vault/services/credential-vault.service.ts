import {
  Inject,
  Injectable,
  Logger,
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
