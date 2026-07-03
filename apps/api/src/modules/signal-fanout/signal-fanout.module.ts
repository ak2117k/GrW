import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import {
  EXECUTE_USER_DEAD_QUEUE,
  EXECUTE_USER_QUEUE,
  SIGNAL_FANOUT_QUEUE,
} from './constants';
import { FanoutEligibilityService } from './services/fanout-eligibility.service';
import { PerUserRateLimiter } from './services/per-user-rate-limiter';
import { SignalFanoutService } from './services/signal-fanout.service';
import { SignalFanoutWorker } from './workers/signal-fanout.worker';

/**
 * TDA-010 signal fan-out engine.
 *
 * Registers the two working queues (`signal-fanout`, `execute-user`) plus the
 * `execute-user-dead` DLQ, the eligibility + rate-limit services, the fan-out
 * worker, and the producer helper (`SignalFanoutService`) that the anand track
 * taps. TenantContextService / PrismaService / ClsService are all @Global, so
 * the eligibility service resolves them without re-import.
 *
 * TDA-011 fills the per-user execution pipeline behind the `AUTO_EXECUTION_PORT`
 * seam (added with the execute-user worker in a later task).
 */
@Module({
  imports: [
    PrismaModule,
    SubscriptionModule,
    BullModule.registerQueue(
      { name: SIGNAL_FANOUT_QUEUE },
      { name: EXECUTE_USER_QUEUE },
      { name: EXECUTE_USER_DEAD_QUEUE },
    ),
  ],
  providers: [
    FanoutEligibilityService,
    PerUserRateLimiter,
    SignalFanoutService,
    SignalFanoutWorker,
  ],
  exports: [SignalFanoutService],
})
export class SignalFanoutModule {}
