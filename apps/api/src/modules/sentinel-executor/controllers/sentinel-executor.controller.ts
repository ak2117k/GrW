// apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts
import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { AiExitExecutionRepository } from '../repositories/ai-exit-execution.repository';
import { toAiExitExecutionDto, type AiExitExecutionDto } from '../dto/ai-exit-execution.dto';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Read-only view of what the auto-exit did (spec §8). Global JWT guard; caller
 * must be ADMIN or allow-listed (ruling R13); rows are ALWAYS the caller's own.
 * Deliberately not on SentinelController, which must stay exit-free.
 */
@Controller('api/sentinel-executor')
export class SentinelExecutorController {
  constructor(private readonly repo: AiExitExecutionRepository) {}

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
}
