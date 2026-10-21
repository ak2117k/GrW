import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AdminOnly, CurrentUser } from '../../../common/decorators';
import { SelfReviewService } from '../services/self-review.service';

/**
 * /api/self-review (contract §API). GETs are open to the authenticated owner (global JwtAuthGuard);
 * every state change is @AdminOnly(). List endpoints return bare arrays; decisions return the row.
 */
@Controller('api/self-review')
export class SelfReviewController {
  constructor(private readonly service: SelfReviewService) {}

  @Get('latest')
  latest() {
    return this.service.latest();
  }

  @Get('runs')
  runs(@Query('limit') limit?: string) {
    return this.service.runs(Number(limit) || 20);
  }

  @Get('results')
  results(@Query('session') session?: string, @Query('kind') kind?: string) {
    return this.service.results(session || undefined, kind || undefined);
  }

  @Get('lessons')
  lessons(@Query('status') status?: string) {
    return this.service.lessons(status || undefined);
  }

  @AdminOnly()
  @Post('lessons/:id/retire')
  @HttpCode(200)
  retire(@Param('id') id: string, @CurrentUser('userId') userId?: string) {
    return this.service.retireLesson(id, userId ?? null);
  }

  @Get('proposals')
  proposals(@Query('status') status?: string) {
    return this.service.proposals(status || undefined);
  }

  @AdminOnly()
  @Post('proposals/:id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @CurrentUser('userId') userId?: string) {
    return this.service.approve(id, userId ?? null);
  }

  @AdminOnly()
  @Post('proposals/:id/reject')
  @HttpCode(200)
  reject(@Param('id') id: string, @CurrentUser('userId') userId?: string) {
    return this.service.reject(id, userId ?? null);
  }

  @AdminOnly()
  @Post('run')
  @HttpCode(202)
  run() {
    return this.service.startRun();
  }
}
