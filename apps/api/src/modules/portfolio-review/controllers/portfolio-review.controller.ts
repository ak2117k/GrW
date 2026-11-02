import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { PortfolioReview } from '../domain/types';
import type { ReviewHistoryRow } from '../repositories/portfolio-review.repository';
import { PortfolioReviewService } from '../services/portfolio-review.service';

/**
 * GET /api/portfolio-review — the caller's portfolio review (real broker book,
 * paper excluded), cached ~15 min; `?refresh=1` recomputes (at most once a
 * minute). Authenticated by the global JwtAuthGuard, scoped to the caller.
 */
@ApiTags('Portfolio review')
@Controller('api/portfolio-review')
export class PortfolioReviewController {
  constructor(private readonly service: PortfolioReviewService) {}

  @Get()
  @ApiOperation({ summary: 'Portfolio review: where the P&L comes from, behaviour patterns, holdings check, ranked suggestions' })
  get(@CurrentUser() user: AuthenticatedUser, @Query('refresh') refresh?: string): Promise<PortfolioReview> {
    return this.service.get({ userId: user.userId, role: user.role }, { refresh: refresh === '1' || refresh === 'true' });
  }

  @Get('history')
  @ApiOperation({ summary: 'Headline numbers of the stored reviews, newest first' })
  history(@CurrentUser('userId') userId: string): Promise<ReviewHistoryRow[]> {
    return this.service.history(userId);
  }
}
