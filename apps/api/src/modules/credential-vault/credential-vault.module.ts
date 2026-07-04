import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { CredentialVaultService } from './services/credential-vault.service';
import { BrokerOverviewService } from './services/broker-overview.service';
import { CredentialDecryptorModule } from './execution/credential-decryptor.module';
import { CredentialRewrapJob } from './jobs/credential-rewrap.job';
import { BrokerController } from './controllers/broker.controller';
import { PerUserBrokerSessionFactory } from '../auto-execution/services/per-user-broker-session.factory';

/**
 * Per-tenant credential vault (TDA-005). Owns the WRITE side
 * (connect/disconnect/status/rewrap) via {@link CredentialVaultService}, which
 * injects KMS_PROVIDER for generateDataKey/wrapKey ONLY.
 *
 * KmsModule + AuditModule are @Global, so they need no import here. MarketDataModule
 * supplies the per-user AngelOneValidator (ephemeral login). The isolated
 * CredentialDecryptorModule (sole unwrap grant) is imported + re-exported in Task 6;
 * the broker.controller + re-wrap job are wired in Tasks 7-8.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, CredentialDecryptorModule],
  controllers: [BrokerController],
  // BrokerOverviewService (TDA-017) composes the isolated decryptor with a
  // disposable per-user broker session. PerUserBrokerSessionFactory is a
  // self-contained provider (only an @Optional USER_SMARTAPI_FACTORY dep), so we
  // provide it locally rather than depend on AutoExecutionModule's @Global export
  // — that keeps this module free of a runtime dependency on auto-execution.
  providers: [
    CredentialVaultService,
    BrokerOverviewService,
    PerUserBrokerSessionFactory,
    CredentialRewrapJob,
  ],
  // Re-export the isolated decryptor module so TDA-010/011 depend on the vault
  // module alone for the CREDENTIAL_DECRYPTOR seam.
  exports: [CredentialVaultService, CredentialRewrapJob, CredentialDecryptorModule],
})
export class CredentialVaultModule {}
