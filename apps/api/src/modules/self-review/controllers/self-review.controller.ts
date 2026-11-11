import { Body, Controller, Get, HttpCode, Optional, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AdminOnly, CurrentUser } from '../../../common/decorators';
import { SelfReviewService } from '../services/self-review.service';
import { renderFixQueueMd, type FixTicketRecord } from '../tickets/fix-queue';
import { FixTicketRepository } from '../tickets/fix-ticket.repository';

/**
 * /api/self-review (contract §API). GETs are open to the authenticated owner (global JwtAuthGuard);
 * every state change is @AdminOnly(). List endpoints return bare arrays; decisions return the row.
 */
@Controller('api/self-review')
export class SelfReviewController {
  constructor(
    private readonly service: SelfReviewService,
    /** Fix tickets (2026-11-04, wrong-decision loop); absent ⇒ the queue is empty. */
    @Optional() private readonly tickets?: FixTicketRepository,
  ) {}

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

  /** Per lesson: how often its mistake happened and what it cost before vs after it went active, with a verdict. */
  @Get('lesson-scorecard')
  lessonScorecard() {
    return this.service.lessonScorecard();
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

  /**
   * The dev fix queue: OPEN first, then cost, then lastSeen. `format=md` answers text/markdown (the shape
   * scripts/ops/pull-fix-queue.sh writes to docs/self-review/fix-queue.md); otherwise a bare array.
   * `status` narrows (OPEN | DONE | WONTFIX).
   */
  @Get('fix-queue')
  async fixQueue(@Res({ passthrough: true }) res: Response, @Query('format') format?: string, @Query('status') status?: string): Promise<FixTicketRecord[] | string> {
    const s = status && ['OPEN', 'DONE', 'WONTFIX'].includes(status.toUpperCase()) ? status.toUpperCase() : undefined;
    const rows = this.tickets ? await this.tickets.queue(s) : [];
    if ((format ?? '').toLowerCase() !== 'md') return rows;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return renderFixQueueMd(rows);
  }

  /**
   * Re-run the review. Optional `session` (YYYY-MM-DD, body or query) backfills that past session — it must be
   * a closed day NSE or MCX traded (e.g. 2026-11-10, NSE holiday with an MCX evening); otherwise 400.
   */
  @AdminOnly()
  @Post('run')
  @HttpCode(202)
  run(@Body() body?: { session?: unknown }, @Query('session') q?: string) {
    const fromBody = body && typeof body === 'object' && typeof body.session === 'string' ? body.session : undefined;
    return this.service.startRun(fromBody ?? q);
  }
}
