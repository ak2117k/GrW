import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { TenantModule } from '../../common/tenant/tenant.module';
import { SubscriptionService } from './subscription.service';

/**
 * Provides/exports {@link SubscriptionService} for the plan-gating consumers
 * added in later TDA-007 tasks.
 */
@Module({
  imports: [PrismaModule, TenantModule],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
