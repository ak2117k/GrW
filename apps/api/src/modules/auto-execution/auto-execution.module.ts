import { Global, Module } from '@nestjs/common';
import { SubscriptionModule } from '../subscription/subscription.module';
import { CredentialVaultModule } from '../credential-vault/credential-vault.module';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { AUTO_EXECUTION_PORT } from '../signal-fanout';
import { AutoExecutionService } from './services/auto-execution.service';
import { AutoTradeRiskSizingService } from './services/auto-trade-risk-sizing.service';
import { ExecutionClaimService } from './services/execution-claim.service';
import { PerUserBrokerSessionFactory } from './services/per-user-broker-session.factory';

/**
 * TDA-011 auto-execution pipeline (Phase 2).
 *
 * Binds the sole implementation of TDA-010's `AUTO_EXECUTION_PORT` seam:
 * `AutoExecutionService` composes the three Phase-1 sub-modules (risk sizing /
 * idempotency claim / disposable per-user broker session) behind the TDA-005
 * decrypt seam and the TDA-007/009 subscription+consent gates.
 *
 * Declared `@Global` and exporting the token so TDA-010's `ExecuteUserWorker`
 * (which injects `@Optional() @Inject(AUTO_EXECUTION_PORT)` inside
 * `SignalFanoutModule`) resolves the binding app-wide without `SignalFanoutModule`
 * having to import this module — which keeps the fan-out lane free of a runtime
 * dependency cycle. `ConsentService`, `AuditService`, `PrismaService`,
 * `TenantContextService` and `ClsService` are all `@Global` and resolve without
 * re-import; `SubscriptionService`, `CREDENTIAL_DECRYPTOR` and
 * `RiskManagerService` come from the imported modules below.
 */
@Global()
@Module({
  imports: [SubscriptionModule, CredentialVaultModule, TradeEngineModule],
  providers: [
    AutoExecutionService,
    AutoTradeRiskSizingService,
    ExecutionClaimService,
    PerUserBrokerSessionFactory,
    { provide: AUTO_EXECUTION_PORT, useExisting: AutoExecutionService },
  ],
  exports: [AUTO_EXECUTION_PORT],
})
export class AutoExecutionModule {}
