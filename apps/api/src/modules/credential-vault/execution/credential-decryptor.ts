import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { KMS_PROVIDER, KmsProvider } from '../../../common/crypto/kms/kms-provider.interface';
import { decryptWithDataKey } from '../crypto/field-cipher';

/** DI token for the sole decrypt-for-execution boundary (TDA-010/011 seam). */
export const CREDENTIAL_DECRYPTOR = Symbol('CREDENTIAL_DECRYPTOR');

export interface DecryptedBrokerCredentials {
  apiKey: string;
  apiSecret: string;
  clientId: string;
  password: string;
  totpSecret: string;
}

export interface DecryptContext {
  reason: 'ORDER' | 'REVALIDATE';
  signalId?: string;
}

/**
 * The one deliberate decrypt-for-execution boundary (TDA-005 §6). This is the
 * ONLY place a field is ever decrypted to plaintext, and the ONLY caller of
 * `KMS_PROVIDER.unwrapKey` (enforced by decrypt-isolation.spec). In prod only
 * this module's IAM role is granted CMK `Decrypt`; the write side holds a
 * different (`GenerateDataKey`/`Encrypt`) grant.
 *
 * It hands callers a scoped LEASE (a callback), not raw plaintext, so the
 * boundary owns the full lifecycle: unwrap -> decrypt -> use() -> ALWAYS zeroize
 * in a `finally` (even if `use` throws). Emits one CREDENTIAL_DECRYPT audit row
 * (metadata only — never the plaintext). No Logger/console call here ever
 * receives a secret.
 */
@Injectable()
export class CredentialDecryptor {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(KMS_PROVIDER) private readonly kms: KmsProvider,
    private readonly audit: AuditService,
  ) {}

  async withDecryptedCredentials<T>(
    userId: string,
    ctx: DecryptContext,
    use: (creds: DecryptedBrokerCredentials) => Promise<T>,
  ): Promise<T> {
    const row = await this.prisma.brokerCredential.findUniqueOrThrow({ where: { userId } });

    const dk = await this.kms.unwrapKey(row.encDataKey);
    let plain: DecryptedBrokerCredentials | null = null;
    try {
      plain = {
        apiKey: decryptWithDataKey(row.encApiKey, dk),
        apiSecret: decryptWithDataKey(row.encApiSecret, dk),
        clientId: decryptWithDataKey(row.encClientId, dk),
        password: decryptWithDataKey(row.encPassword, dk),
        totpSecret: decryptWithDataKey(row.encTotpSecret, dk),
      };
      // Record THAT a decrypt happened (who/why/keyVersion) — never the plaintext.
      await this.audit.append({
        action: 'CREDENTIAL_DECRYPT',
        userId,
        target: 'angel_one',
        meta: { reason: ctx.reason, signalId: ctx.signalId ?? null, keyVersion: row.keyVersion },
      });
      return await use(plain);
    } finally {
      dk.fill(0); // reliably scrub the DEK buffer
      if (plain) zeroizeStrings(plain);
    }
  }
}

/**
 * Best-effort scrub of the plaintext container. JS strings are immutable, so the
 * underlying characters may linger until GC (documented residual, TDA-005 §6 /
 * open decision §10.3); overwriting the properties minimises live references.
 */
function zeroizeStrings(creds: DecryptedBrokerCredentials): void {
  creds.apiKey = '';
  creds.apiSecret = '';
  creds.clientId = '';
  creds.password = '';
  creds.totpSecret = '';
}
