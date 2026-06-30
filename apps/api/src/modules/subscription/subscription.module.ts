import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { TenantModule } from '../../common/tenant/tenant.module';
import { AdminSubscriptionController } from './admin-subscription.controller';
import { MeSubscriptionController } from './me-subscription.controller';
import { SubscriptionService } from './subscription.service';

/**
 * Provides/exports {@link SubscriptionService} and the USER/ADMIN subscription
 * endpoints for the TDA-007 plan-gating surface.
 */
@Module({
  imports: [PrismaModule, TenantModule],
  controllers: [MeSubscriptionController, AdminSubscriptionController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
