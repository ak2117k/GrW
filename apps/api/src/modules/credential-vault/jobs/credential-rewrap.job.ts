import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { KMS_PROVIDER, KmsProvider } from '../../../common/crypto/kms/kms-provider.interface';

/**
 * Key-rotation re-wrap job (TDA-005 §7). When the CMK version advances, every
 * `encDataKey` is re-wrapped under the new version WITHOUT decrypting any field —
 * only the wrapped DEK changes. This is the economic point of envelope
 * encryption: rotating the KEK is O(users) tiny writes, not O(users × fields)
 * re-encryption.
 *
 * It runs inside the vault module (it needs `unwrapKey` — the decrypt grant —
 * plus `wrapKey`) and is the only unwrap caller besides the CredentialDecryptor
 * (decrypt-isolation.spec allows both). Idempotent: rows already at the current
 * keyVersion are skipped, so re-runs and manual (ADMIN) / scheduled triggers are
 * safe.
 */
@Injectable()
export class CredentialRewrapJob {
  private readonly logger = new Logger(CredentialRewrapJob.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(KMS_PROVIDER) private readonly kms: KmsProvider,
    private readonly audit: AuditService,
  ) {}

  /** Re-wrap every credential row not already at the current KEK version. */
  async rewrapAll(): Promise<{ rotated: number }> {
    const current = this.kms.keyVersion();
    const rows = await this.prisma.brokerCredential.findMany({
      where: { keyVersion: { not: current } },
      select: { id: true, userId: true, encDataKey: true, keyVersion: true },
    });

    let rotated = 0;
    for (const row of rows) {
      const dk = await this.kms.unwrapKey(row.encDataKey); // old KEK still resolves it
      try {
        const rewrapped = await this.kms.wrapKey(dk); // NEW KEK
        await this.prisma.brokerCredential.update({
          where: { id: row.id },
          data: {
            encDataKey: rewrapped.wrapped,
            keyVersion: rewrapped.keyVersion,
            lastRotatedAt: new Date(),
          },
        });
        await this.audit.append({
          action: 'CREDENTIAL_ROTATE',
          userId: row.userId,
          target: 'angel_one',
          meta: { from: row.keyVersion, to: rewrapped.keyVersion },
        });
        rotated += 1;
      } finally {
        dk.fill(0); // zeroize the DEK
      }
    }

    if (rotated > 0) {
      this.logger.log(`Re-wrapped ${rotated} credential row(s) to keyVersion ${current}`);
    }
    return { rotated };
  }
}
