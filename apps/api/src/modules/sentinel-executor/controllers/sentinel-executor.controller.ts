// apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts
import { Controller, ForbiddenException, Get, HttpCode, Logger, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { AiExitExecutionRepository } from '../repositories/ai-exit-execution.repository';
import { toAiExitExecutionDto, type AiExitExecutionDto } from '../dto/ai-exit-execution.dto';
import { ManualExitService } from '../services/manual-exit.service';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What the auto-exit did (spec §8), plus the owner's manual "Exit now". Global
 * JWT guard; caller must be ADMIN or allow-listed (ruling R13); rows are ALWAYS
 * the caller's own. Deliberately not on SentinelController, which must stay exit-free.
 */
@Controller('api/sentinel-executor')
export class SentinelExecutorController {
  private readonly logger = new Logger(SentinelExecutorController.name);

  constructor(
    private readonly repo: AiExitExecutionRepository,
    private readonly manual: ManualExitService,
  ) {}

  @Get('executions')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ): Promise<AiExitExecutionDto[]> {
    const allowed = parseAutoExitConfig(process.env).userIds;
    if (!user?.userId || (user.role !== 'ADMIN' && !allowed.includes(user.userId))) {
      throw new ForbiddenException('AI exits are not enabled for this account');
    }
    const n = Number.parseInt(String(limit ?? ''), 10);
    const take = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
    const rows = await this.repo.listForUser(user.userId, take);
    return rows.map(toAiExitExecutionDto);
  }

  /**
   * The owner's "Exit now" on one OPEN F&O position tracker. Places a REAL
   * order. Returns at once with the attempt's row — CLAIMED when this request
   * started it, or the attempt already working (a repeat click) — and the
   * broker work continues in the background; the UI polls GET executions.
   * 403 not allowed / 404 not the caller's tracker / 422 not exitable here.
   */
  @Post('exit/:trackerId')
  @HttpCode(202)
  async exit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('trackerId') trackerId: string,
  ): Promise<AiExitExecutionDto> {
    const r = await this.manual.request(user, trackerId);
    r.done.catch((err) => this.logger.error(`[manual-exit] attempt ${r.row.id} errored: ${errText(err)} — row left for the sweep`));
    return toAiExitExecutionDto(r.row);
  }
}
