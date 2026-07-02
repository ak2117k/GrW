import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { TenantModule } from '../../common/tenant/tenant.module';
import { AdminConsentController } from './admin-consent.controller';
import { ConsentController } from './consent.controller';
import { ConsentGuard } from './consent.guard';
import { ConsentService } from './consent.service';

/**
 * TDA-009 versioned consent & disclaimer gate.
 *
 * `@Global()` (mirrors `AuditModule`/`TenantModule`) so the `ConsentGuard` and
 * TDA-011's fan-out can inject {@link ConsentService} without re-importing.
 * `AuditModule` is itself `@Global`, so `AuditService` injects without an
 * import here; `PrismaModule`/`TenantModule` are imported for their providers.
 *
 * Exports `ConsentService` + `ConsentGuard` so TDA-011 can adopt the guard via
 * `@RequiresConsent()` with zero design work.
 */
@Global()
@Module({
  imports: [PrismaModule, TenantModule],
  controllers: [ConsentController, AdminConsentController],
  providers: [ConsentService, ConsentGuard],
  exports: [ConsentService, ConsentGuard],
})
export class ConsentModule {}
