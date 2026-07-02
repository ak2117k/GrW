import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { CredentialDecryptor, CREDENTIAL_DECRYPTOR } from './credential-decryptor';

/**
 * The isolated execution submodule holding the SOLE KMS *unwrap* grant
 * (TDA-005 §6, roadmap §2). It provides + exports the CredentialDecryptor under
 * the `CREDENTIAL_DECRYPTOR` token — the exact, minimal symbol TDA-010 (fan-out)
 * and TDA-011 (auto-execution) import to obtain a user's live Angel One creds.
 *
 * KmsModule + AuditModule are @Global, so only PrismaModule is imported here. If
 * the execution path later lifts into its own service/VPC, this module is the
 * wire contract and nothing else moves.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    CredentialDecryptor,
    { provide: CREDENTIAL_DECRYPTOR, useExisting: CredentialDecryptor },
  ],
  exports: [CredentialDecryptor, CREDENTIAL_DECRYPTOR],
})
export class CredentialDecryptorModule {}
