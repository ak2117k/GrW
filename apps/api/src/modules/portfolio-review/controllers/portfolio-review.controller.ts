import { Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { ReviewQuota } from '../domain/types';
import type { ReviewHistoryRow } from '../repositories/portfolio-review.repository';
import { PortfolioReviewService, type LatestReviewResponse, type RunResponse } from '../services/portfolio-review.service';

/**
 * Portfolio review, run on demand (owner 2026-11-02). Opening the page (GET /) reads the latest
 * STORED review only — it never computes. POST /run starts a run (answers DONE with the review, or
 * RUNNING with a run id to poll at GET /runs/:id). Each run is recorded for the monthly quota hook
 * (GET /quota; counted, NOT enforced). Authenticated by the global JwtAuthGuard, scoped to the caller.
 */
@ApiTags('Portfolio review')
@Controller('api/portfolio-review')
export class PortfolioReviewController {
  constructor(private readonly service: PortfolioReviewService) {}

  @Get()
  @ApiOperation({ summary: 'The latest stored portfolio review (never computes), the run in progress and the quota' })
  latest(@CurrentUser('userId') userId: string): Promise<LatestReviewResponse> {
    return this.service.latest(userId);
  }

  @Post('run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run a portfolio review now: the report + the action plan. Returns DONE with the review, or RUNNING to poll' })
  run(@CurrentUser() user: AuthenticatedUser): Promise<RunResponse> {
    return this.service.startRun({ userId: user.userId, role: user.role });
  }

  @Get('runs/:id')
  @ApiOperation({ summary: 'One review run (status, progress; the review once DONE)' })
  async runStatus(@CurrentUser('userId') userId: string, @Param('id') id: string): Promise<RunResponse> {
    const r = await this.service.runStatus(userId, id);
    if (!r) throw new NotFoundException('No such review run');
    return r;
  }

  @Get('quota')
  @ApiOperation({ summary: 'Reviews used this month vs the free limit (not enforced yet)' })
  quota(@CurrentUser('userId') userId: string): Promise<ReviewQuota> {
    return this.service.reviewQuota(userId);
  }

  @Get('history')
  @ApiOperation({ summary: 'Headline numbers of the stored reviews, newest first' })
  history(@CurrentUser('userId') userId: string): Promise<ReviewHistoryRow[]> {
    return this.service.history(userId);
  }
}
