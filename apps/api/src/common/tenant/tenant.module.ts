import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';

/**
 * Shared tenant-context module (TDA-003).
 *
 * `@Global()` so any module — notably `PrismaService` (Task 2) — can inject
 * {@link TenantContextService} without re-importing. It relies on the CLS store
 * established by `ClsModule.forRoot({ middleware: { mount: true } })`, which is
 * wired (and is itself global) in `AppModule`.
 */
@Global()
@Module({
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class TenantModule {}
