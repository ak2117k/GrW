import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { TenantModule } from '../../common/tenant/tenant.module';
import { ConsentService } from './consent.service';

/**
 * TDA-009 versioned consent & disclaimer gate.
 *
 * `@Global()` (mirrors `AuditModule`/`TenantModule`) so the `ConsentGuard` and
 * TDA-011's fan-out can inject {@link ConsentService} without re-importing.
 * `AuditModule` is itself `@Global`, so `AuditService` injects without an
 * import here; `PrismaModule`/`TenantModule` are imported for their providers.
 *
 * Controllers + `ConsentGuard` are added in Task 5.
 */
@Global()
@Module({
  imports: [PrismaModule, TenantModule],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
