import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Tamper-evident audit-log module (TDA-008).
 *
 * `@Global()` so any module can inject {@link AuditService} without re-importing
 * — a structural mirror of `TenantModule`. {@link AuditService} injects
 * `PrismaService` directly (PrismaModule is itself `@Global`), so this module
 * does NOT import PrismaModule.
 *
 * The `AuditController` exposes the read-only ADMIN-only verify/list/export
 * surface (Task 4). It is a pure reader; {@link AuditService.append} remains the
 * sole writer.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
