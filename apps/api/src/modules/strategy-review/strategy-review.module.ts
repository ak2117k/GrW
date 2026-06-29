import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { StrategyReviewController } from './controllers/strategy-review.controller';
import { StrategyReviewService } from './services/strategy-review.service';

/**
 * Strategy Review — read-only analytics that aggregates the platform's
 * stored trading history (Chartink alerts, watch entries, real trades)
 * into strategy-improvement metrics. No writes, no queues.
 */
@Module({
  imports: [PrismaModule],
  controllers: [StrategyReviewController],
  providers: [StrategyReviewService],
})
export class StrategyReviewModule {}
