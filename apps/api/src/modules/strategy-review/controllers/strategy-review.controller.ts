import { Controller, Get, Logger, Query } from '@nestjs/common';
import { StrategyReviewQueryDto } from '../dto/strategy-review-query.dto';
import {
  StrategyReviewService,
  type StrategyReview,
} from '../services/strategy-review.service';

/**
 * Read-only analytics endpoint. Aggregates stored Chartink alerts + watch
 * entries + real trades into strategy-improvement metrics.
 *
 *   GET /api/strategy-review?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Both query params are optional; omitting them reviews all stored history.
 */
@Controller('api/strategy-review')
export class StrategyReviewController {
  private readonly logger = new Logger(StrategyReviewController.name);

  constructor(private readonly service: StrategyReviewService) {}

  @Get()
  async getReview(
    @Query() query: StrategyReviewQueryDto,
  ): Promise<StrategyReview> {
    return this.service.getReview(query.from, query.to);
  }
}
