import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Tamper-evident audit-log module (TDA-008).
 *
 * `@Global()` so any module can inject {@link AuditService} without re-importing
 * — a structural mirror of `TenantModule`. {@link AuditService} injects
 * `PrismaService` directly (PrismaModule is itself `@Global`), so this module
 * does NOT import PrismaModule.
 *
 * NOTE: the `AuditController` (read-only verify/query surface) is added in
 * Task 4; it does not exist yet, so no `controllers` array is declared here.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
