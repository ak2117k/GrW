import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { KMS_PROVIDER, KmsProvider } from '../../../common/crypto/kms/kms-provider.interface';
import { encryptWithDataKey } from '../../credential-vault/crypto/field-cipher';
import { CredentialDecryptor } from '../../credential-vault/execution/credential-decryptor';

export const TELEGRAM_AUDIT_TARGET = 'telegram';

/** Non-secret view of the stored session (safe to return to the client). */
export interface TelegramSessionMeta {
  userId: string;
  apiId: number;
  phoneMasked: string;
  status: string;
  lastError: string | null;
  connectedAt: Date;
}

export interface TelegramSecrets {
  apiHash: string;
  session: string;
}

/** Keep only the last two digits: "••••••••12". Never log even this with other identifiers. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 2 ? '••' : `${'•'.repeat(Math.max(4, digits.length - 2))}${digits.slice(-2)}`;
}

/**
 * Persistence for the owner's Telegram MTProto session. Same envelope as the broker vault:
 * a fresh DEK from the KMS provider seals apiHash + session string with the credential-vault
 * field cipher; only the WRAPPED DEK is stored. Decrypt goes through the CredentialDecryptor
 * (the sole unwrap boundary). Audit rows carry metadata only.
 */
@Injectable()
export class TelegramSessionStore {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(KMS_PROVIDER) private readonly kms: KmsProvider,
    private readonly decryptor: CredentialDecryptor,
    private readonly audit: AuditService,
  ) {}

  async save(
    userId: string,
    input: { apiId: number; apiHash: string; session: string; phone: string },
    reqMeta: Record<string, unknown> = {},
  ): Promise<void> {
    const dk = await this.kms.generateDataKey();
    const phoneMasked = maskPhone(input.phone);
    try {
      const data = {
        apiId: input.apiId,
        encApiHash: encryptWithDataKey(input.apiHash, dk.plaintext),
        encSession: encryptWithDataKey(input.session, dk.plaintext),
        encDataKey: dk.wrapped,
        keyVersion: dk.keyVersion,
        phoneMasked,
        status: 'connected',
        lastError: null,
        connectedAt: new Date(),
      };
      await this.prisma.telegramSession.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
    } finally {
      dk.plaintext.fill(0);
    }
    await this.audit.append({
      action: 'CREDENTIAL_CONNECT',
      userId,
      target: TELEGRAM_AUDIT_TARGET,
      meta: { phoneMasked, ...reqMeta },
    });
  }

  async meta(userId: string): Promise<TelegramSessionMeta | null> {
    const row = await this.prisma.telegramSession.findUnique({ where: { userId } });
    return row
      ? {
          userId: row.userId,
          apiId: row.apiId,
          phoneMasked: row.phoneMasked,
          status: row.status,
          lastError: row.lastError,
          connectedAt: row.connectedAt,
        }
      : null;
  }

  /** The session the listener should open: the owner's when given, else the most recent live one. */
  async findListenable(ownerUserId: string | null): Promise<TelegramSessionMeta | null> {
    const row = await this.prisma.telegramSession.findFirst({
      where: { status: { not: 'revoked' }, ...(ownerUserId ? { userId: ownerUserId } : {}) },
      orderBy: { connectedAt: 'desc' },
    });
    return row ? await this.meta(row.userId) : null;
  }

  async withSecrets<T>(userId: string, use: (s: TelegramSecrets) => Promise<T>): Promise<T> {
    const row = await this.prisma.telegramSession.findUniqueOrThrow({ where: { userId } });
    return this.decryptor.withDecryptedSecrets(
      userId,
      TELEGRAM_AUDIT_TARGET,
      {
        encDataKey: row.encDataKey,
        keyVersion: row.keyVersion,
        fields: { apiHash: row.encApiHash, session: row.encSession },
      },
      { reason: 'TELEGRAM' },
      (plain) => use({ apiHash: plain.apiHash, session: plain.session }),
    );
  }

  async markStatus(userId: string, status: string, lastError: string | null): Promise<void> {
    await this.prisma.telegramSession.updateMany({ where: { userId }, data: { status, lastError } });
  }

  async delete(userId: string, reqMeta: Record<string, unknown> = {}): Promise<void> {
    await this.prisma.telegramSession.deleteMany({ where: { userId } });
    await this.audit.append({
      action: 'CREDENTIAL_DELETE',
      userId,
      target: TELEGRAM_AUDIT_TARGET,
      meta: { ...reqMeta },
    });
  }
}
